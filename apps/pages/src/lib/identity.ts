import { overlapCast, isString, isNumber } from "@opensesame/os-domain";
/**
 * Identity plane session.
 *
 * The access token lives in memory for the tab session only — never OPFS,
 * never localStorage. The control-plane also sets an HttpOnly cookie, so
 * requests carry credentials as well as the bearer header.
 */

import { useCallback, useEffect, useState } from "react";
import { probeDaemon } from "./daemon.js";
import { localNetworkFetch } from "./local-network-fetch.js";
import {
  type FailureClass,
  classifyResponse,
  classifyThrown,
} from "./probe-failure.js";
import { loadSettings } from "./settings.js";
import { isLoopbackUrl } from "./urls.js";

const IDENTITY_FETCH_MS = 8000;
const PROBE_MS = 4000;
/** Sentinel when Host minted the session without Identity (local authority). */
const HOST_LOCAL_IDENTITY = "host-local";

export type Principal = {
  id: string;
  state: string;
  assurance: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  version: number;
  identities: Array<{
    id: string;
    kind: string;
    issuer: string;
    displayHint?: string;
    assurance: string;
  }>;
};

export type IdentitySession = {
  principalId: string;
  accessToken: string;
  /** Normalized scheme/host/port that issued this credential. */
  issuerOrigin: string;
  /**
   * Absent for a token the operator pasted in: only the API knows its horizon,
   * and guessing one would drop a working token. A 401 ends it instead.
   */
  expiresAt?: string;
  /**
   * Pasted in by the operator rather than minted here, so no cookie belongs to
   * it. Requests must withhold cookies or a surviving one answers in its place.
   */
  adopted?: boolean;
  /** Resumed from the HttpOnly cookie; no bearer is copied into JavaScript. */
  cookieOnly?: boolean;
};

export class IdentityError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IdentityError";
    this.status = status;
  }
}

export class HostSessionError extends Error {
  constructor(
    readonly code: "setup_required" | "identity_changed" | "invalid_host",
    message: string,
  ) {
    super(message);
    this.name = "HostSessionError";
  }
}

let session: IdentitySession | null = null;
type HostSession = {
  accessToken: string;
  expiresAt: number;
  hostApi: string;
  identityAccessToken: string;
};
export type AuthorityHostSession = HostSession;
let hostSession: HostSession | null = null;
let pendingHostSession: Promise<HostSession> | null = null;
let pendingIdentitySession: Promise<IdentitySession> | null = null;
/** In-flight revoke, so a reconnect cannot race its cookie teardown. */
let pendingRevoke: Promise<void> | null = null;
/**
 * A previous tab's HttpOnly cookie still authenticates, but no bearer for it
 * survived here. The session cannot be resumed — only shown and revoked.
 */
let orphanCookie = false;
/** Bumped whenever the session is ended, to fence slow session creators. */
let sessionEpoch = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function currentSessionDefault(): IdentitySession | null {
  if (session && session.issuerOrigin !== identityOrigin()) {
    clearSession();
    return null;
  }
  if (session?.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    session = null;
    clearHostSession();
    // Expiry would otherwise be silent, leaving the rail claiming a session
    // that can no longer act. Emit off-stack because this is also called from
    // inside listeners.
    queueMicrotask(emit);
  }
  return session;
}

export function clearSession(): void {
  session = null;
  clearHostSession();
  // Anything already in flight that would set a session must notice it was
  // ended, or a slow connect resurrects credentials after a lock.
  sessionEpoch += 1;
  emit();
}

/**
 * Detect a provisional cookie left behind by an earlier tab. The bearer lives in
 * memory only, so after a reload the cookie can still act while this tab reads
 * as disconnected — the user has to be told, and given a way to end it.
 */
async function probeOrphanSessionDefault(): Promise<boolean> {
  if (session) return false;
  // Unreachable means unknown, and warning about a session we cannot see would
  // be noise on every offline load.
  setOrphan(await cookieAuthenticates(false));
  return orphanCookie;
}

function setOrphan(next: boolean): void {
  if (orphanCookie === next) return;
  orphanCookie = next;
  emit();
}

/** Does the cookie alone still authenticate? `whenUnreachable` breaks the tie. */
async function cookieAuthenticates(whenUnreachable: boolean): Promise<boolean> {
  try {
    const res = await localNetworkFetch(`${identityBase()}/v1/principals/me`, {
      credentials: "include",
      timeoutMs: PROBE_MS,
    });
    return res.ok;
  } catch {
    return whenUnreachable;
  }
}

/**
 * End the session everywhere. Dropping the in-memory bearer is not enough — the
 * control plane also set an HttpOnly cookie that authenticates on its own, so
 * the server has to revoke it.
 */
function endSessionDefault(): void {
  // Send the bearer we are about to forget: an adopted CLI token has no cookie,
  // so it is the only thing that identifies the session to revoke.
  const bearer =
    session && !session.cookieOnly && session.issuerOrigin === identityOrigin()
      ? session.accessToken
      : undefined;
  clearSession();
  setOrphan(false);
  // Unconditional, because a reload loses the in-memory bearer while the
  // HttpOnly cookie lives on and authenticates on its own. Chained onto any
  // revoke still in flight, so none is dropped from tracking and left able to
  // land its cookie clear after a reconnect.
  pendingRevoke = (pendingRevoke ?? Promise.resolve())
    .then(() => revokeRequest(bearer))
    .then(async (res) => {
      if (res.ok) return;
      // The revoke was refused, so the cookie may still act. Say so rather than
      // leave the UI claiming a session that is alive is gone.
      await recheckOrphan();
    })
    .catch(async () => {
      // Offline or unreachable: assume the session outlived us until proven
      // otherwise, so the warning stays up and a reconnect revokes again.
      await recheckOrphan();
    });
}

function revokeRequest(bearer?: string): Promise<Response> {
  return localNetworkFetch(
    `${identityBase()}/v1/principals/provisional/revoke`,
    {
      method: "POST",
      credentials: "include",
      timeoutMs: IDENTITY_FETCH_MS,
      ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined),
    },
  );
}

async function recheckOrphan(): Promise<void> {
  if (session) return;
  setOrphan(await cookieAuthenticates(true));
}

/** Wait for every revoke to land, including ones started while waiting. */
async function settleRevokes(): Promise<void> {
  while (pendingRevoke) {
    const inFlight = pendingRevoke;
    await inFlight;
    if (pendingRevoke === inFlight) pendingRevoke = null;
  }
}

function identityBaseDefault(): string {
  return loadSettings().identityApi.replace(/\/$/, "");
}

function identityOrigin(): string {
  try {
    return new URL(identityBase()).origin;
  } catch {
    return "";
  }
}

function hostBaseDefault(): string {
  return loadSettings().hostApi.replace(/\/$/, "");
}

export function clearHostSession(): void {
  hostSession = null;
  pendingHostSession = null;
}

function currentHostSession(): HostSession | null {
  if (
    !hostSession ||
    hostSession.hostApi !== hostBase() ||
    hostSession.expiresAt <= Date.now()
  ) {
    hostSession = null;
    return null;
  }
  // Host-local sessions do not bind to an Identity bearer.
  if (hostSession.identityAccessToken === HOST_LOCAL_IDENTITY) {
    return hostSession;
  }
  const identity = currentSession();
  if (!identity || hostSession.identityAccessToken !== identity.accessToken) {
    hostSession = null;
    return null;
  }
  return hostSession;
}

async function hostSessionFailure(
  response: Response,
  fallback: string,
): Promise<HostSessionError> {
  const code = [400, 401, 403, 404, 409].includes(response.status)
    ? "setup_required"
    : "invalid_host";
  try {
    const payload = overlapCast(await response.json());
    const detail =
      payload.body?.hint ??
      payload.body?.error ??
      payload.hint ??
      payload.error;
    if (isString(detail)) {
      return new HostSessionError(code, `${fallback}: ${detail}`);
    }
  } catch {
    /* non-JSON error */
  }
  return new HostSessionError(code, `${fallback} (${response.status}).`);
}

/**
 * True when Pages may use Host as the local authority IdP (no Identity URL).
 * Host still enforces non-production + OPENSESAME_DEV_BOOTSTRAP server-side.
 */
function hostLocalSessionEligibleDefault(
  hostApi: string = hostBase(),
): boolean {
  return Boolean(hostApi) && isLoopbackUrl(hostApi);
}

/**
 * Mint a Host session without Identity. Returns null when the Host refuses
 * (production, no demo bootstrap) so callers can fall back to Identity.
 */
async function mintHostLocalSession(): Promise<HostSession | null> {
  const hostApi = hostBase();
  if (!hostLocalSessionEligible(hostApi)) return null;
  const response = await localNetworkFetch(`${hostApi}/api/v1/session/local`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: "{}",
    timeoutMs: IDENTITY_FETCH_MS,
  });
  if (
    response.status === 403 ||
    response.status === 404 ||
    response.status === 503
  ) {
    return null;
  }
  if (!response.ok) {
    throw await hostSessionFailure(response, "Host-local session failed");
  }
  const issued = overlapCast(await response.json());
  if (
    !isString(issued.access_token) ||
    !issued.access_token.startsWith("opaque-session:") ||
    !isNumber(issued.expires_in) ||
    issued.expires_in <= 0
  ) {
    throw new HostSessionError(
      "invalid_host",
      "Host returned an invalid local session.",
    );
  }
  return {
    accessToken: issued.access_token,
    expiresAt: Date.now() + issued.expires_in * 1000,
    hostApi,
    identityAccessToken: HOST_LOCAL_IDENTITY,
  };
}

async function mintHostSession(
  identity: IdentitySession,
): Promise<HostSession> {
  const unchanged = () =>
    currentSession()?.accessToken === identity.accessToken;
  const hostApi = hostBase();
  const authorize = await localNetworkFetch(
    `${hostApi}/api/v1/device/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({
        client_id: "opensesame-pages",
        scope: "opensesame.session",
      }),
      timeoutMs: IDENTITY_FETCH_MS,
    },
  );
  if (!authorize.ok) {
    throw await hostSessionFailure(authorize, "Host session request failed");
  }
  const grant = overlapCast(await authorize.json());
  if (
    !isString(grant.device_code) ||
    !isString(grant.user_code)
  ) {
    throw new HostSessionError(
      "invalid_host",
      "Host returned an invalid device grant.",
    );
  }
  if (!unchanged()) {
    throw new HostSessionError(
      "identity_changed",
      "Identity changed during Host sign-in.",
    );
  }

  const approve = await identityFetch("/v1/device/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_code: grant.user_code }),
  });
  if (!approve.ok) {
    throw await hostSessionFailure(approve, "Host session approval failed");
  }
  if (!unchanged()) {
    throw new HostSessionError(
      "identity_changed",
      "Identity changed during Host sign-in.",
    );
  }

  const token = await localNetworkFetch(`${hostApi}/api/v1/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({
      device_code: grant.device_code,
      client_id: "opensesame-pages",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    timeoutMs: IDENTITY_FETCH_MS,
  });
  if (!token.ok) {
    throw await hostSessionFailure(token, "Host session exchange failed");
  }
  const issued = overlapCast(await token.json());
  if (
    !isString(issued.access_token) ||
    !issued.access_token.startsWith("opaque-session:") ||
    !isNumber(issued.expires_in) ||
    issued.expires_in <= 0
  ) {
    throw new HostSessionError(
      "invalid_host",
      "Host returned an invalid session.",
    );
  }
  if (!unchanged()) {
    throw new HostSessionError(
      "identity_changed",
      "Identity changed during Host sign-in.",
    );
  }
  return {
    accessToken: issued.access_token,
    expiresAt: Date.now() + issued.expires_in * 1000,
    hostApi,
    identityAccessToken: identity.accessToken,
  };
}

/**
 * Ensure an OpenSesame Identity principal for this tab.
 *
 * OpenSesame’s control plane is the IdP: a provisional principal is the default
 * on-ramp. Better Auth / upstream IdP linking is optional and does not gate
 * Host connector OAuth. Dedupes concurrent callers (Settings + Connections).
 */
export async function ensureIdentitySession(): Promise<IdentitySession> {
  const existing = currentSession();
  if (existing) {
    return existing;
  }
  if (!identityBase()) {
    throw new IdentityError(
      "No Identity API is configured. Set the Identity URL in Settings — OpenSesame issues your session there (upstream IdP / Better Auth is optional).",
      0,
    );
  }
  if (!pendingIdentitySession) {
    pendingIdentitySession = connectProvisional();
  }
  const pending = pendingIdentitySession;
  try {
    return await pending;
  } finally {
    if (pendingIdentitySession === pending) pendingIdentitySession = null;
  }
}

/**
 * Mint (or reuse) a Host session.
 * Prefers Host-local authority on loopback (no Identity plane). Falls back to
 * Identity device approval when local mint is unavailable.
 */
async function ensureHostSessionDefault(): Promise<HostSession> {
  const existing = currentHostSession();
  if (existing) {
    return existing;
  }

  if (!pendingHostSession) {
    pendingHostSession = (async () => {
      const local = await mintHostLocalSession();
      if (local) {
        hostSession = local;
        return local;
      }
      const identity = await ensureIdentitySession();
      const issued = await mintHostSession(identity);
      hostSession = issued;
      return issued;
    })();
  }
  const pending = pendingHostSession;
  try {
    return await pending;
  } finally {
    if (pendingHostSession === pending) pendingHostSession = null;
  }
}

/** Fetch against the Host as the connected principal, never as deployment operator. */
async function hostFetchDefault(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let active: HostSession;
  try {
    active = await ensureHostSession();
  } catch (error) {
    if (
      !(error instanceof HostSessionError) ||
      error.code !== "identity_changed"
    ) {
      throw error;
    }
    active = await ensureHostSession();
  }
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${active.accessToken}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await localNetworkFetch(`${hostBase()}${path}`, {
    ...init,
    headers,
    credentials: "omit",
    timeoutMs: IDENTITY_FETCH_MS,
  });
  if (response.status === 401) clearHostSession();
  return response;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = overlapCast(await res.json());
    return body.message ?? body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/** Fetch against the Identity API, attaching the session when we have one. */
async function identityFetchDefault(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const active = currentSession();
  if (active && !active.cookieOnly) {
    headers.set("authorization", `Bearer ${active.accessToken}`);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await localNetworkFetch(`${identityBase()}${path}`, {
    ...init,
    headers,
    // An adopted token stands alone. Sending a cookie beside it would let a
    // survivor answer once the bearer is refused, running every ceremony as a
    // principal other than the one on screen — and hiding the refusal.
    credentials: active?.adopted ? "omit" : "include",
    timeoutMs: IDENTITY_FETCH_MS,
  });
  if (res.status === 401 && active) noteUnauthorized();
  return res;
}

/**
 * The API refused the bearer we hold. Keeping it would resend a dead credential
 * under a UI still claiming a session; the cookie may have outlived it, so that
 * is surfaced as an orphan instead. Also for callers fetching outside
 * `identityFetch`, such as the SDK-driven claim ceremony.
 */
function noteUnauthorizedDefault(): void {
  if (!session) return;
  clearSession();
  void recheckOrphan();
}

async function identityJsonDefault<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await identityFetch(path, init);
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  return overlapCast(await res.json());
}

/** Start a provisional session. This is the anonymous on-ramp the API exposes. */
async function connectProvisionalDefault(): Promise<IdentitySession> {
  const resumed = await resumeCookieSession();
  if (resumed) return resumed;
  // A cookie left by an earlier tab is only flagged once the Authority panel has
  // probed for it. Connecting from Agents or Sites never probes, so look here
  // too rather than mint a second session beside one nobody is watching.
  if (!session && !orphanCookie) await probeOrphanSession();
  // End an earlier session before starting another, so the old one does not live
  // out its TTL with a credential nobody is watching.
  if (session || orphanCookie) endSession();
  // Let any revoke finish first: its response clears the cookie by name, which
  // would otherwise land after the new one is set and take it with it.
  await settleRevokes();
  const epoch = sessionEpoch;
  const issuer = identityBase();
  if (!issuer) {
    throw new IdentityError("No Identity API is configured.", 0);
  }
  const res = await localNetworkFetch(`${issuer}/v1/principals/provisional`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: "{}",
    timeoutMs: IDENTITY_FETCH_MS,
  });
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  const body = overlapCast(await res.json());
  if (sessionEpoch !== epoch) {
    // A lock or Disconnect landed while this was in flight. Adopting it now
    // would resurrect a credential the user just ended, so throw it away.
    pendingRevoke = (pendingRevoke ?? Promise.resolve())
      .then(() => revokeRequest(body.accessToken))
      .then(() => undefined)
      .catch(() => undefined);
    throw new IdentityError(
      "The session was ended while connecting. Connect again.",
      409,
    );
  }
  session = {
    principalId: body.principalId,
    accessToken: body.accessToken,
    expiresAt: body.expiresAt,
    issuerOrigin: new URL(issuer).origin,
  };
  emit();
  return session;
}

async function resumeCookieSession(): Promise<IdentitySession | null> {
  if (session) return session;
  try {
    const res = await localNetworkFetch(`${identityBase()}/v1/principals/me`, {
      credentials: "include",
      timeoutMs: PROBE_MS,
    });
    if (!res.ok) return null;
    const body = overlapCast(await res.json());
    if (!isString(body.id) || !body.id) return null;
    session = {
      principalId: body.id,
      // An opaque local identity for Host-session deduplication only. It is
      // never sent as a bearer; the HttpOnly cookie authenticates requests.
      accessToken: `cookie:${body.id}`,
      cookieOnly: true,
      issuerOrigin: identityOrigin(),
    };
    setOrphan(false);
    emit();
    return session;
  } catch {
    return null;
  }
}

/** Adopt a token the operator already holds (CLI `opensesame-id`, tests). */
async function adoptTokenDefault(accessToken: string): Promise<void> {
  // Always end what came before, detected orphan or not: a cookie this tab
  // never saw would otherwise keep acting alongside the pasted token.
  endSession();
  await settleRevokes();
  const token = accessToken.trim();
  const epoch = sessionEpoch;
  const issuerOrigin = identityOrigin();
  // Prove the token itself works, with the cookie deliberately withheld. A
  // mistyped token would otherwise appear to work by riding a leftover cookie,
  // and every ceremony would run as the wrong principal.
  const res = await localNetworkFetch(`${identityBase()}/v1/principals/me`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: "omit",
    timeoutMs: IDENTITY_FETCH_MS,
  });
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  const me = overlapCast(await res.json());
  if (sessionEpoch !== epoch) {
    throw new IdentityError(
      "The session was ended while adopting that token. Try again.",
      409,
    );
  }
  session = {
    principalId: me.id ?? "unknown",
    accessToken: token,
    adopted: true,
    issuerOrigin,
    // No horizon: the API issued this token and never told us when it dies.
    // Inventing one would drop a token the API still accepts; a 401 ends it.
  };
  emit();
}

async function fetchPrincipalDefault(): Promise<Principal> {
  return identityJson<Principal>("/v1/principals/me");
}

export type HealthState = "unknown" | "reachable" | "unreachable";

/** True when Host API is the daemon's `/host` Serve proxy (paired node). */
export function hostRoutedViaDaemon(
  hostApi: string,
  daemonApi: string,
): boolean {
  const host = hostApi.trim().replace(/\/$/, "");
  const daemon = daemonApi.trim().replace(/\/$/, "");
  if (!host || !daemon) return false;
  if (host === `${daemon}/host`) return true;
  try {
    const hostUrl = new URL(host);
    const daemonUrl = new URL(daemon);
    return (
      hostUrl.origin === daemonUrl.origin &&
      hostUrl.pathname.replace(/\/$/, "") === "/host"
    );
  } catch {
    return false;
  }
}

/** A probe result that says *why*, for the connectivity monitor. */
export type ProbeResult = {
  health: HealthState;
  failure: FailureClass | null;
};

export async function probeIdentityDetailed(): Promise<ProbeResult> {
  const base = identityBase();
  if (!base) return { health: "unreachable", failure: null };
  try {
    const res = await localNetworkFetch(`${base}/v1/health/live`, {
      credentials: "omit",
      timeoutMs: PROBE_MS,
    });
    if (!res.ok) {
      return { health: "unreachable", failure: classifyResponse(res.status) };
    }
    // A foreign listener on :8788 can answer with 401 JSON and look "up".
    // OpenSesame control-plane always returns `{ "status": "ok" }`.
    try {
      const body = overlapCast(await res.json());
      return body.status === "ok"
        ? { health: "reachable", failure: null }
        : { health: "unreachable", failure: "not-opensesame" };
    } catch {
      return { health: "unreachable", failure: "not-opensesame" };
    }
  } catch (error) {
    return { health: "unreachable", failure: classifyThrown(error) };
  }
}

async function probeIdentityDefault(): Promise<HealthState> {
  return (await probeIdentityDetailed()).health;
}

/**
 * Host plane reachability for the rail / Authority cards.
 *
 * Prefer a direct Host API health check. When Settings point Host at the paired
 * daemon's `/host` proxy, a live daemon counts as Host reachable — connecting
 * the node must flip the indicator even if gateway isn't on the upstream port.
 */
const HOST_HEALTH_PATHS = ["/api/v1/health", "/health/live"] as const;

/**
 * Which health path this Host answered on last time.
 *
 * A gateway serves one of the two and 404s the other, so trying them in a
 * fixed order doubles every probe against half of them — and under a polling
 * cadence that is a permanent tax. Remember the winner and lead with it.
 */
let hostHealthPath: string | null = null;

export function resetHostHealthPathForTests(): void {
  hostHealthPath = null;
}

export async function probeHostDetailed(): Promise<ProbeResult> {
  const base = hostBase();
  if (!base) return { health: "unreachable", failure: null };
  const daemon = loadSettings().daemonApi.trim();
  const viaDaemon = Boolean(daemon && hostRoutedViaDaemon(base, daemon));

  const direct = (async (): Promise<ProbeResult> => {
    // When Host is daemon-proxied, don't wait long on a dead upstream port.
    const timeoutMs = viaDaemon ? 2000 : PROBE_MS;
    const ordered = hostHealthPath
      ? [
          hostHealthPath,
          ...HOST_HEALTH_PATHS.filter((p) => p !== hostHealthPath),
        ]
      : [...HOST_HEALTH_PATHS];
    let failure: FailureClass | null = null;
    for (const path of ordered) {
      try {
        const res = await localNetworkFetch(`${base}${path}`, {
          credentials: "omit",
          timeoutMs,
        });
        if (res.ok) {
          hostHealthPath = path;
          return { health: "reachable", failure: null };
        }
        // A 404 here just means the other path is the right one; keep the
        // first *meaningful* refusal instead.
        if (res.status !== 404) failure = classifyResponse(res.status);
      } catch (error) {
        // Deliberately *not* breaking out here. A thrown error looks like "the
        // origin is down", but a CORS policy that covers one route and not the
        // other throws exactly the same way — so the second path still has to
        // be tried. Costs a doubled request while Host is genuinely down; the
        // degraded cadence backs off, so it stays cheap.
        failure = classifyThrown(error);
      }
    }
    return {
      health: "unreachable",
      failure: failure ?? "not-opensesame",
    };
  })();

  const daemonOk = (async () => {
    if (!viaDaemon || !daemon) return false;
    try {
      const health = await probeDaemon(daemon);
      return health.service === "opensesame-daemon";
    } catch {
      return false;
    }
  })();

  const [directResult, okDaemon] = await Promise.all([direct, daemonOk]);
  if (directResult.health === "reachable" || okDaemon) {
    return { health: "reachable", failure: null };
  }
  return directResult;
}

async function probeHostDefault(): Promise<HealthState> {
  return (await probeHostDetailed()).health;
}

/** Live orphan-cookie state, so a failed revoke puts the warning back. */
function useOrphanSessionDefault(): boolean {
  const [value, setValue] = useState(orphanCookie);
  useEffect(() => {
    const listener = () => setValue(orphanCookie);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}

function useIdentitySessionDefault(): IdentitySession | null {
  const [value, setValue] = useState(currentSession);
  useEffect(() => {
    const listener = () => setValue(currentSession());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}

/** Connect-on-demand helper shared by every section that needs a principal. */
function useConnectDefault() {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await ensureIdentitySession();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not reach OpenSesame Identity.",
      );
    } finally {
      setConnecting(false);
    }
  }, []);
  return { connecting, error, connect };
}

export const identitySeams = {
  hostFetch: hostFetchDefault,
  endSession: endSessionDefault,
  ensureHostSession: ensureHostSessionDefault,
  hostLocalSessionEligible: hostLocalSessionEligibleDefault,
  useIdentitySession: useIdentitySessionDefault,
  useConnect: useConnectDefault,
  currentSession: currentSessionDefault,
  probeOrphanSession: probeOrphanSessionDefault,
  identityBase: identityBaseDefault,
  hostBase: hostBaseDefault,
  identityFetch: identityFetchDefault,
  noteUnauthorized: noteUnauthorizedDefault,
  identityJson: identityJsonDefault,
  connectProvisional: connectProvisionalDefault,
  adoptToken: adoptTokenDefault,
  probeIdentity: probeIdentityDefault,
  probeHost: probeHostDefault,
  useOrphanSession: useOrphanSessionDefault,
  fetchPrincipal: fetchPrincipalDefault,
};

export async function hostFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return identitySeams.hostFetch(path, init);
}

export function endSession(): void {
  return identitySeams.endSession();
}

export async function ensureHostSession(): Promise<HostSession> {
  return identitySeams.ensureHostSession();
}

export function hostLocalSessionEligible(hostApi?: string): boolean {
  // Resolve hostBase inside the seamed implementation, not here. Evaluating
  // hostBase() as a default argument would still run it after tests replace
  // identitySeams.hostLocalSessionEligible.
  return hostApi === undefined
    ? identitySeams.hostLocalSessionEligible()
    : identitySeams.hostLocalSessionEligible(hostApi);
}

export function useIdentitySession(): IdentitySession | null {
  return identitySeams.useIdentitySession();
}

export function useConnect() {
  return identitySeams.useConnect();
}

export function currentSession(): IdentitySession | null {
  return identitySeams.currentSession();
}
export async function probeOrphanSession(): Promise<boolean> {
  return identitySeams.probeOrphanSession();
}
export function identityBase(): string {
  return identitySeams.identityBase();
}
export function hostBase(): string {
  return identitySeams.hostBase();
}
export async function identityFetch(
  ...args: Parameters<typeof identityFetchDefault>
): ReturnType<typeof identityFetchDefault> {
  return identitySeams.identityFetch(...args);
}
export function noteUnauthorized(): void {
  return identitySeams.noteUnauthorized();
}
export async function identityJson<T>(
  ...args: Parameters<typeof identityJsonDefault>
): Promise<T> {
  // SAFETY: Type assertion required; TypeScript cannot prove this overlap.
  return identitySeams.identityJson(...args) as Promise<T>;
}
export async function connectProvisional(): Promise<IdentitySession> {
  return identitySeams.connectProvisional();
}
export async function adoptToken(accessToken: string): Promise<void> {
  return identitySeams.adoptToken(accessToken);
}
export async function probeIdentity(): Promise<HealthState> {
  return identitySeams.probeIdentity();
}
export async function probeHost(): Promise<HealthState> {
  return identitySeams.probeHost();
}
export function useOrphanSession(): boolean {
  return identitySeams.useOrphanSession();
}
export async function fetchPrincipal(): Promise<Principal> {
  return identitySeams.fetchPrincipal();
}

/**
 * Identity plane session.
 *
 * The access token lives in memory for the tab session only — never OPFS,
 * never localStorage. The control-plane also sets an HttpOnly cookie, so
 * requests carry credentials as well as the bearer header.
 */

import { useCallback, useEffect, useState } from "react";
import { loadSettings } from "./settings.js";

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
let hostSession: HostSession | null = null;
let pendingHostSession: Promise<HostSession> | null = null;
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

export function currentSession(): IdentitySession | null {
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
export async function probeOrphanSession(): Promise<boolean> {
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
    const res = await fetch(`${identityBase()}/v1/principals/me`, {
      credentials: "include",
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
export function endSession(): void {
  // Send the bearer we are about to forget: an adopted CLI token has no cookie,
  // so it is the only thing that identifies the session to revoke.
  const bearer = session?.cookieOnly ? undefined : session?.accessToken;
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
  return fetch(`${identityBase()}/v1/principals/provisional/revoke`, {
    method: "POST",
    credentials: "include",
    ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
  });
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

export function identityBase(): string {
  return loadSettings().identityApi.replace(/\/$/, "");
}

export function hostBase(): string {
  return loadSettings().hostApi.replace(/\/$/, "");
}

export function clearHostSession(): void {
  hostSession = null;
  pendingHostSession = null;
}

function currentHostSession(): HostSession | null {
  const identity = currentSession();
  if (
    !hostSession ||
    !identity ||
    hostSession.hostApi !== hostBase() ||
    hostSession.identityAccessToken !== identity.accessToken ||
    hostSession.expiresAt <= Date.now()
  ) {
    hostSession = null;
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
    const payload = (await response.json()) as {
      error?: unknown;
      hint?: unknown;
      body?: { error?: unknown; hint?: unknown };
    };
    const detail =
      payload.body?.hint ??
      payload.body?.error ??
      payload.hint ??
      payload.error;
    if (typeof detail === "string") {
      return new HostSessionError(code, `${fallback}: ${detail}`);
    }
  } catch {
    /* non-JSON error */
  }
  return new HostSessionError(code, `${fallback} (${response.status}).`);
}

async function mintHostSession(
  identity: IdentitySession,
): Promise<HostSession> {
  const unchanged = () =>
    currentSession()?.accessToken === identity.accessToken;
  const hostApi = hostBase();
  const authorize = await fetch(`${hostApi}/api/v1/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({
      client_id: "opensesame-pages",
      scope: "opensesame.session",
    }),
  });
  if (!authorize.ok) {
    throw await hostSessionFailure(authorize, "Host session request failed");
  }
  const grant = (await authorize.json()) as {
    device_code?: unknown;
    user_code?: unknown;
  };
  if (
    typeof grant.device_code !== "string" ||
    typeof grant.user_code !== "string"
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

  const token = await fetch(`${hostApi}/api/v1/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({
      device_code: grant.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  if (!token.ok) {
    throw await hostSessionFailure(token, "Host session exchange failed");
  }
  const issued = (await token.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof issued.access_token !== "string" ||
    !issued.access_token.startsWith("opaque-session:") ||
    typeof issued.expires_in !== "number" ||
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

async function ensureHostSession(): Promise<HostSession> {
  const existing = currentHostSession();
  if (existing) return existing;
  const identity = currentSession();
  if (!identity) {
    throw new Error("Connect to Identity before using the Host.");
  }
  if (!pendingHostSession) {
    pendingHostSession = mintHostSession(identity).then((issued) => {
      hostSession = issued;
      return issued;
    });
  }
  const pending = pendingHostSession;
  try {
    return await pending;
  } finally {
    if (pendingHostSession === pending) pendingHostSession = null;
  }
}

/** Fetch against the Host as the connected principal, never as deployment operator. */
export async function hostFetch(
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
  const response = await fetch(`${hostBase()}${path}`, {
    ...init,
    headers,
    credentials: "omit",
  });
  if (response.status === 401) clearHostSession();
  return response;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/** Fetch against the Identity API, attaching the session when we have one. */
export async function identityFetch(
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
  const res = await fetch(`${identityBase()}${path}`, {
    ...init,
    headers,
    // An adopted token stands alone. Sending a cookie beside it would let a
    // survivor answer once the bearer is refused, running every ceremony as a
    // principal other than the one on screen — and hiding the refusal.
    credentials: active?.adopted ? "omit" : "include",
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
export function noteUnauthorized(): void {
  if (!session) return;
  clearSession();
  void recheckOrphan();
}

export async function identityJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await identityFetch(path, init);
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  return (await res.json()) as T;
}

/** Start a provisional session. This is the anonymous on-ramp the API exposes. */
export async function connectProvisional(): Promise<IdentitySession> {
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
  const res = await fetch(`${identityBase()}/v1/principals/provisional`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: "{}",
  });
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  const body = (await res.json()) as {
    principalId: string;
    accessToken: string;
    expiresAt: string;
  };
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
  };
  emit();
  return session;
}

async function resumeCookieSession(): Promise<IdentitySession | null> {
  if (session) return session;
  try {
    const res = await fetch(`${identityBase()}/v1/principals/me`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) return null;
    session = {
      principalId: body.id,
      // An opaque local identity for Host-session deduplication only. It is
      // never sent as a bearer; the HttpOnly cookie authenticates requests.
      accessToken: `cookie:${body.id}`,
      cookieOnly: true,
    };
    setOrphan(false);
    emit();
    return session;
  } catch {
    return null;
  }
}

/** Adopt a token the operator already holds (CLI `opensesame-id`, tests). */
export async function adoptToken(accessToken: string): Promise<void> {
  // Always end what came before, detected orphan or not: a cookie this tab
  // never saw would otherwise keep acting alongside the pasted token.
  endSession();
  await settleRevokes();
  const token = accessToken.trim();
  const epoch = sessionEpoch;
  // Prove the token itself works, with the cookie deliberately withheld. A
  // mistyped token would otherwise appear to work by riding a leftover cookie,
  // and every ceremony would run as the wrong principal.
  const res = await fetch(`${identityBase()}/v1/principals/me`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: "omit",
  });
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  const me = (await res.json()) as { id?: string };
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
    // No horizon: the API issued this token and never told us when it dies.
    // Inventing one would drop a token the API still accepts; a 401 ends it.
  };
  emit();
}

export async function fetchPrincipal(): Promise<Principal> {
  return identityJson<Principal>("/v1/principals/me");
}

export type HealthState = "unknown" | "reachable" | "unreachable";

export async function probeIdentity(): Promise<HealthState> {
  try {
    const res = await fetch(`${identityBase()}/v1/health/live`, {
      credentials: "omit",
    });
    return res.ok ? "reachable" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function probeHost(): Promise<HealthState> {
  try {
    const res = await fetch(`${hostBase()}/api/v1/health`, {
      credentials: "omit",
    });
    return res.ok ? "reachable" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** Live orphan-cookie state, so a failed revoke puts the warning back. */
export function useOrphanSession(): boolean {
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

export function useIdentitySession(): IdentitySession | null {
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
export function useConnect(): {
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
} {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await connectProvisional();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not reach the Identity API.",
      );
    } finally {
      setConnecting(false);
    }
  }, []);
  return { connecting, error, connect };
}

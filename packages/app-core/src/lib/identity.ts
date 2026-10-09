import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Identity plane session.
 *
 * The access token lives in memory for the tab session only — never OPFS,
 * never localStorage. The control-plane also sets an HttpOnly cookie, so
 * requests carry credentials as well as the bearer header.
 */

import {
  type BrowserGrant,
  BrowserPairingError,
  clearBrowserPairing,
  currentBrowserGrant,
  pairedHostFetch,
} from "./browser-pairing.js";
import {
  deviceIdentityOrigin,
  identityPlaneRequest,
  isDeviceIdentityMode,
  isRemoteIdentityConfigured,
  remoteIdentityApi,
  resolveIdentityBase,
} from "./device-identity.js";
import {
  HostSessionError,
  IdentityError,
  type IdentitySession,
  type Principal,
} from "./identity-session-types.js";
import {
  type FailureClass,
  classifyResponse,
  classifyThrown,
} from "./probe-failure.js";
import { loadSettings } from "./settings.js";
import { captureRemoteIdentityCodeData } from "./vault/captured-remote-code-data.js";
export { HostSessionError, IdentityError };
export type { IdentitySession, Principal };

export { isDeviceIdentityMode, isRemoteIdentityConfigured, remoteIdentityApi };

const IDENTITY_FETCH_MS = 8000;
const PROBE_MS = 4000;

let session: IdentitySession | null = null;
type HostSession = BrowserGrant;
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

/** Called whenever the session or the orphan-cookie state changes. */
export function subscribeIdentitySession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a previous tab's cookie still authenticates with no bearer here. */
export function orphanSessionActive(): boolean {
  return orphanCookie;
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
    const res = await identityPlaneRequest("/v1/principals/me", {
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
  return identityPlaneRequest("/v1/principals/provisional/revoke", {
    method: "POST",
    credentials: "include",
    timeoutMs: IDENTITY_FETCH_MS,
    ...(bearer
      ? { headers: { authorization: `Bearer ${bearer}` } }
      : undefined),
  });
}

async function recheckOrphan(): Promise<void> {
  if (session) return;
  setOrphan(await cookieAuthenticates(true));
}

/** Wait for every revoke to land, including ones started while waiting. */
export async function settleRevokes(): Promise<void> {
  while (pendingRevoke) {
    const inFlight = pendingRevoke;
    await inFlight;
    if (pendingRevoke === inFlight) pendingRevoke = null;
  }
}

function identityBaseDefault(): string {
  return resolveIdentityBase();
}

function identityOrigin(): string {
  if (isDeviceIdentityMode()) return deviceIdentityOrigin();
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
  clearBrowserPairing();
}

/** Eligibility means a live explicitly approved browser grant, never merely loopback. */
function hostLocalSessionEligibleDefault(
  hostApi: string = hostBase(),
): boolean {
  return Boolean(hostApi) && currentBrowserGrant(hostApi) !== null;
}

/** Ensure the optional Identity session without changing browser Host authority. */
export async function ensureIdentitySession(): Promise<IdentitySession> {
  const existing = currentSession();
  if (existing) {
    return existing;
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
 * Reuse an explicitly approved tab-owned Host grant. No request implicitly
 * creates local authority or exchanges an Identity bearer for Host authority.
 */
async function ensureHostSessionDefault(): Promise<HostSession> {
  const active = hostBase() ? currentBrowserGrant(hostBase()) : null;
  if (!active)
    throw new HostSessionError(
      "setup_required",
      "This browser has no approved grant for that action.",
    );
  return active;
}

/** Host requests use only the approved origin/key-bound DPoP grant. */
async function hostFetchDefault(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  await ensureHostSession();
  try {
    return await pairedHostFetch(hostBase(), path, init);
  } catch (error) {
    if (error instanceof BrowserPairingError)
      throw new HostSessionError("setup_required", error.message);
    throw error;
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body: JsonObject = overlapCast(await res.json());
    if (isString(body.message)) return body.message;
    if (isString(body.error)) return body.error;
    return `Request failed (${res.status}).`;
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
  const res = await identityPlaneRequest(path, {
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
  // A cookie left by an earlier tab is only flagged once something has probed
  // for it. Connecting from Agents or Sites never probes, so look here
  // too rather than mint a second session beside one nobody is watching.
  if (!session && !orphanCookie) await probeOrphanSession();
  // End an earlier session before starting another, so the old one does not live
  // out its TTL with a credential nobody is watching.
  if (session || orphanCookie) endSession();
  // Let any revoke finish first: its response clears the cookie by name, which
  // would otherwise land after the new one is set and take it with it.
  await settleRevokes();
  const epoch = sessionEpoch;
  const res = await identityPlaneRequest("/v1/principals/provisional", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: "{}",
    timeoutMs: IDENTITY_FETCH_MS,
  });
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  const body: JsonObject = overlapCast(await res.json());
  if (
    !isString(body.principalId) ||
    !isString(body.accessToken) ||
    (body.expiresAt !== undefined && !isString(body.expiresAt))
  ) {
    throw new IdentityError(
      "Identity returned an invalid provisional session.",
      502,
    );
  }
  const accessToken = body.accessToken;
  if (sessionEpoch !== epoch) {
    // A lock or Disconnect landed while this was in flight. Adopting it now
    // would resurrect a credential the user just ended, so throw it away.
    pendingRevoke = (pendingRevoke ?? Promise.resolve())
      .then(() => revokeRequest(accessToken))
      .then(() => undefined)
      .catch(() => undefined);
    throw new IdentityError(
      "The session was ended while connecting. Connect again.",
      409,
    );
  }
  const nextSession: IdentitySession = {
    principalId: body.principalId,
    accessToken,
    expiresAt: body.expiresAt,
    issuerOrigin: identityOrigin(),
  };
  session = nextSession;
  emit();
  return nextSession;
}

async function resumeCookieSession(): Promise<IdentitySession | null> {
  if (session) return session;
  // Device-native identity has no HttpOnly cookie plane.
  if (isDeviceIdentityMode()) return null;
  try {
    const res = await identityPlaneRequest("/v1/principals/me", {
      credentials: "include",
      timeoutMs: PROBE_MS,
    });
    if (!res.ok) return null;
    const body = overlapCast(await res.json());
    if (!isString(body.id) || !body.id) return null;
    const nextSession: IdentitySession = {
      principalId: body.id,
      // An opaque local identity for Host-session deduplication only. It is
      // never sent as a bearer; the HttpOnly cookie authenticates requests.
      accessToken: `cookie:${body.id}`,
      cookieOnly: true,
      issuerOrigin: identityOrigin(),
    };
    session = nextSession;
    setOrphan(false);
    emit();
    return nextSession;
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
  const res = await identityPlaneRequest("/v1/principals/me", {
    headers: { authorization: `Bearer ${token}` },
    credentials: "omit",
    timeoutMs: IDENTITY_FETCH_MS,
  });
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  const me: BoundaryValue = await res.json();
  if (!isJsonObject(me) || !isString(me.id)) {
    throw new IdentityError("Identity returned an invalid principal.", 502);
  }
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

/** Put a stashed bearer back in this tab after an OIDC round-trip. */
function restoreSessionDefault(next: IdentitySession): void {
  session = next;
  setOrphan(false);
  emit();
}

export type HealthState = "unknown" | "reachable" | "unreachable";

/** A probe result that says *why*, for the connectivity monitor. */
export type ProbeResult = {
  health: HealthState;
  failure: FailureClass | null;
};

export async function probeIdentityDetailed(): Promise<ProbeResult> {
  // Device-native mode is always the local host — never probe the network.
  if (isDeviceIdentityMode()) {
    return { health: "reachable", failure: null };
  }
  const base = identityBase();
  if (!base) return { health: "unreachable", failure: null };
  try {
    const res = await identityPlaneRequest("/v1/health/live", {
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
    const thrown =
      error instanceof DOMException || error instanceof Error
        ? error
        : String(error);
    return { health: "unreachable", failure: classifyThrown(thrown) };
  }
}

async function probeIdentityDefault(): Promise<HealthState> {
  return (await probeIdentityDetailed()).health;
}

export const identitySeams = {
  hostFetch: hostFetchDefault,
  endSession: endSessionDefault,
  ensureHostSession: ensureHostSessionDefault,
  hostLocalSessionEligible: hostLocalSessionEligibleDefault,
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
  fetchPrincipal: fetchPrincipalDefault,
  restoreSession: restoreSessionDefault,
};

export async function hostFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return identitySeams.hostFetch(path, init);
}

export function endSession(): void {
  identitySeams.endSession();
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
  identitySeams.noteUnauthorized();
}
export async function identityJson<T>(
  ...args: Parameters<typeof identityJsonDefault>
): Promise<T> {
  return identitySeams.identityJson<T>(...args);
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
export async function fetchPrincipal(): Promise<Principal> {
  return identitySeams.fetchPrincipal();
}

export function restoreSession(next: IdentitySession): void {
  identitySeams.restoreSession(next);
}

/** Original bearer transport DATA only; the private Store must prove primary/all configured factors. */
export function captureOriginalIdentityCodeData(original: () => void) {
  const active = session;
  const epoch = sessionEpoch;
  const base = loadSettings().identityApi.replace(/\/+$/u, "");
  if (!active || active.cookieOnly || !active.accessToken || !base)
    throw new Error("Original remote identity code transport is unavailable.");
  const selected = Object.freeze({ ...active });
  const check = () => {
    original();
    if (
      session !== active ||
      sessionEpoch !== epoch ||
      loadSettings().identityApi.replace(/\/+$/u, "") !== base ||
      active.principalId !== selected.principalId ||
      active.accessToken !== selected.accessToken ||
      active.issuerOrigin !== selected.issuerOrigin ||
      active.cookieOnly !== selected.cookieOnly ||
      active.expiresAt !== selected.expiresAt ||
      (selected.expiresAt &&
        (!Number.isFinite(Date.parse(selected.expiresAt)) ||
          Date.parse(selected.expiresAt) <= Date.now()))
    )
      throw new Error("The original identity code transport ended.");
  };
  check();
  return captureRemoteIdentityCodeData(
    base,
    selected.accessToken,
    selected.issuerOrigin,
    check,
  );
}

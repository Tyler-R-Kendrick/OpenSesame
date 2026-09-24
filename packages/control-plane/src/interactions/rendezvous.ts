import { FORBIDDEN_URL_PARAMS } from "@opensesame/os-domain";

/**
 * Rendezvous: admission and routing for the cross-device interaction layer
 * (ADR 0086).
 *
 * Two concerns live here, both deliberately pure and I/O-free so they can be
 * unit-tested in isolation and reused from both the short-link landing and the
 * create route:
 *
 * 1. **Continuation** — a bare `/i/<ref>` landing is a dead end unless it can
 *    hand the reader on to a surface that actually runs the ceremony. Where a
 *    client app (the PWA) is configured, the landing is a *launcher* that deep
 *    links into it carrying nothing but the reference. Where none is, the
 *    landing is an *address*: the reference names an interaction that will
 *    appear in the reader's inbox once they sign in on a device, and this link
 *    is not something to follow.
 * 2. **Admission** — raising an interaction costs an authenticated principal,
 *    but an authenticated principal that can mint one every millisecond is a
 *    way to flood every approver's inbox and exhaust the one-live-per-ceremony
 *    index. A per-requester sliding window paces that without paging anyone.
 *
 * The reference is the *only* thing that ever travels in a continuation URL.
 * It authorizes nothing on its own (see `@opensesame/os-domain`'s interaction
 * ref), so carrying it in a link is safe in exactly the way carrying the
 * request details would not be.
 */

/** The three spellings of "this machine", where plaintext transport is safe. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

/** Ceiling on any base URL this module will parse. Hostile input is length. */
const MAX_BASE_URL_LENGTH = 2048;

function isLoopbackLiteral(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * HTTPS, or HTTP against a loopback literal.
 *
 * The loopback exception is the same one `buildInteractionUrl` makes: there is
 * no network path to protect between a process and `127.0.0.1`, and requiring
 * a certificate there only pushes developers toward disabling verification.
 */
function acceptableTransport(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackLiteral(url.hostname);
}

/**
 * Refuse a URL whose query or fragment names credential material.
 *
 * The launcher builder appends no parameters at all, so this looks vacuous —
 * and is not. The client-app base is operator-configured, and a deployment
 * whose configured base carried `?token=…` would otherwise print that token
 * into every landing page's continuation link. Refusing at construction is the
 * only place that catches it.
 */
function assertNoForbiddenParams(url: URL): void {
  const named = [
    ...url.searchParams.keys(),
    ...new URLSearchParams(url.hash.replace(/^#/, "")).keys(),
  ].map((name) => name.toLowerCase());
  const forbidden = named.find((name) => FORBIDDEN_URL_PARAMS.includes(name));
  if (forbidden !== undefined) {
    throw new Error(
      `continuation URL would carry a forbidden parameter: ${forbidden}`,
    );
  }
}

/**
 * Validate a configured client-app base, and return its normalized form.
 *
 * Shared with `assertSecureConfig` so a bad `OPENSESAME_CLIENT_APP_URL` fails
 * the boot rather than surfacing as a landing page that silently drops the
 * launcher — a misconfiguration that reads as "the app link is just gone".
 *
 * Throws for a base that is not parseable, is not acceptable transport, is
 * over-long, carries userinfo, or already carries a query or fragment. A base
 * path is allowed and preserved (Pages serves under `/OpenSesame/`).
 */
/** Whether a client-app base must be https (production) or may be loopback http. */
export interface ClientAppUrlOptions {
  requireHttps: boolean;
}

export function assertClientAppUrl(
  clientAppUrl: string,
  options: ClientAppUrlOptions,
): URL {
  if (clientAppUrl.length > MAX_BASE_URL_LENGTH) {
    throw new Error("OPENSESAME_CLIENT_APP_URL is malformed (too long)");
  }
  let base: URL;
  try {
    base = new URL(clientAppUrl);
  } catch {
    throw new Error("OPENSESAME_CLIENT_APP_URL is not a valid URL");
  }
  if (options.requireHttps) {
    if (base.protocol !== "https:") {
      throw new Error("OPENSESAME_CLIENT_APP_URL must use https in production");
    }
  } else if (!acceptableTransport(base)) {
    throw new Error(
      "OPENSESAME_CLIENT_APP_URL must be https, except against a loopback host",
    );
  }
  if (base.username !== "" || base.password !== "") {
    throw new Error("OPENSESAME_CLIENT_APP_URL must not carry userinfo");
  }
  if (base.search !== "" || base.hash !== "") {
    throw new Error(
      "OPENSESAME_CLIENT_APP_URL must not carry a query or fragment",
    );
  }
  assertNoForbiddenParams(base);
  return base;
}

/**
 * The canonical launcher URL for a reference under a client-app base.
 *
 * `URL` has already collapsed `.`/`..` and normalized the path before the
 * prefix is read, so the built link cannot climb out of the deployment's base
 * path. Trailing slashes are stripped so one base produces one spelling.
 */
function buildLauncherUrl(base: URL, ref: string): string {
  const prefix = base.pathname.replace(/\/+$/, "");
  const built = new URL(`${base.origin}${prefix}/i/${encodeURIComponent(ref)}`);
  assertNoForbiddenParams(built);
  return built.toString();
}

/**
 * How a landing page should continue: launch a configured client app, or state
 * that the reference is an address that surfaces in the reader's inbox.
 */
export type Continuation =
  | { readonly mode: "launcher"; readonly url: string }
  | { readonly mode: "address" };

/**
 * Decide the continuation for a reference.
 *
 * A configured, well-formed client-app base yields a launcher; anything else —
 * no base, or a base that cannot be certified safe — yields an address. A
 * misconfigured base must never turn a scan into a 500, so a build failure
 * degrades to address mode rather than propagating.
 */
export function resolveContinuation(options: {
  clientAppUrl?: string | undefined;
  ref: string;
}): Continuation {
  const clientAppUrl = options.clientAppUrl?.trim();
  if (clientAppUrl === undefined || clientAppUrl === "") {
    return { mode: "address" };
  }
  try {
    const base = assertClientAppUrl(clientAppUrl, { requireHttps: false });
    return { mode: "launcher", url: buildLauncherUrl(base, options.ref) };
  } catch {
    return { mode: "address" };
  }
}

/**
 * Per-requester admission for raising interactions.
 *
 * A sliding window keyed by the requester's opaque handle, bounded and shed on
 * every call because the map is keyed by a value that grows with distinct
 * requesters. Wall-clock rather than an injected clock: pacing is about real
 * elapsed time, and a caller cannot be allowed to hold a window open by
 * controlling a test clock.
 */
const REQUESTER_WINDOW_MS = 60_000;
const REQUESTER_BUDGET = 60;
const REQUESTER_FENCE_ENTRIES = 4_096;
const requesterAttempts = new Map<string, number[]>();

/**
 * Record one attempt to raise an interaction; return whether it is admitted.
 *
 * `requesterKey` is the caller's opaque requester handle, never a raw
 * principal id — the same value that reaches an approver's screen — so this
 * map holds nothing that identifies a person.
 */
export function admitRequester(
  requesterKey: string,
  nowMs: number = Date.now(),
): boolean {
  for (const [key, values] of requesterAttempts) {
    const live = values.filter((at) => nowMs - at < REQUESTER_WINDOW_MS);
    if (live.length === 0) requesterAttempts.delete(key);
    else if (live.length !== values.length) requesterAttempts.set(key, live);
  }
  while (requesterAttempts.size > REQUESTER_FENCE_ENTRIES) {
    const oldest = requesterAttempts.keys().next().value;
    if (oldest === undefined) break;
    requesterAttempts.delete(oldest);
  }
  const seen = (requesterAttempts.get(requesterKey) ?? []).filter(
    (at) => nowMs - at < REQUESTER_WINDOW_MS,
  );
  if (seen.length >= REQUESTER_BUDGET) return false;
  requesterAttempts.set(requesterKey, [...seen, nowMs]);
  return true;
}

/**
 * Test hook: clear the requester admission window.
 *
 * Module-global state outlives the app instance a suite builds, so a suite
 * that raises many interactions would otherwise pace the next one.
 */
export function resetRequesterAdmission(): void {
  requesterAttempts.clear();
}

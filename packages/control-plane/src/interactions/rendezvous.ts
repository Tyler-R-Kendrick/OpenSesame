import {
  type CeremonyRouteId,
  buildCeremonyUrl,
  buildClaimLink,
  ceremonyPath,
  ceremonyRoutePrefix,
} from "@opensesame/ceremony-kit";
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
 * The interaction route's fixed prefix (`spec/config/ceremony-routes.json`,
 * `interaction`; ADR 0140 §3), read through ceremony-kit like every other
 * ceremony path. The Identity API's short link and the client app's launcher
 * share it; `ceremony-routes.test.ts` holds it to the spec.
 */
export const INTERACTION_ROUTE = ceremonyRoutePrefix("interaction").replace(
  /\/+$/,
  "",
);

/** The path of a reference under {@link INTERACTION_ROUTE}. */
export function interactionPath(ref: string): string {
  return ceremonyPath("interaction", { ref });
}

/**
 * A ceremony route's link on the client app (ADR 0140 §4:
 * `OPENSESAME_CLIENT_APP_URL` is the one ceremony origin): `/i/<ref>`,
 * `/approve/<ref>`, `/device`, `/claim`, under the deployment's base path.
 * Built by ceremony-kit over `spec/config/ceremony-routes.json`, never by
 * hand, so a link can carry nothing but its path. `null` when no client app
 * is configured, or its base cannot be certified safe — the caller then
 * falls back to its own zero-JS page.
 */
export function clientAppLink(
  clientAppUrl: string | undefined,
  id: CeremonyRouteId,
  params: Readonly<Record<string, string>> = {},
): string | null {
  const configured = clientAppUrl?.trim();
  if (!configured) return null;
  try {
    const base = assertClientAppUrl(configured, { requireHttps: false });
    return buildCeremonyUrl(base.href, id, params);
  } catch {
    return null;
  }
}

/**
 * Where a claim's `verificationUri` sends the person: the client app's
 * `/claim` route when one is configured, otherwise this service's own
 * server-rendered `/v1/claims/<id>/verify`, the zero-JS fallback.
 */
export function claimVerificationUri(
  config: { publicUrl: string; clientAppUrl?: string | undefined },
  claimId: string,
): string {
  return claimLinks(config, { session: { id: claimId } }).verificationUri;
}

/** A claim's links, as every claim-creation response carries them. */
export interface ClaimLinks {
  verificationUri: string;
  /** `verificationUri` with the claim bearer in its fragment (RFC 8628 §3.3.1). */
  verificationUriComplete?: string;
}

/**
 * Both links for a freshly minted claim (ADR 0062: the bearer to present
 * and the user code are separate factors).
 *
 * With a client app, `verificationUriComplete` is its `/claim` route with
 * the bearer in the fragment — `…/claim#token=osc_clm_…` — so the person who
 * opens it lands on a claim already presented and is asked only for the user
 * code, as the auth.md flow's claim-attempt link does (ADR 0092). The
 * fragment never reaches a server log or a `Referer`, and the response that
 * carries this link already carries the bearer itself as `claimToken`.
 * Without a client app the field is omitted: the zero-JS verify page cannot
 * complete a claim, so there is nothing to open it with.
 */
export function claimLinks(
  config: { publicUrl: string; clientAppUrl?: string | undefined },
  claim: { session: { id: string }; token?: string },
): ClaimLinks {
  const route = clientAppLink(config.clientAppUrl, "claim");
  if (route === null) {
    return {
      verificationUri: `${config.publicUrl}/v1/claims/${claim.session.id}/verify`,
    };
  }
  return claim.token === undefined
    ? { verificationUri: route }
    : {
        verificationUri: route,
        verificationUriComplete: buildClaimLink(route, claim.token),
      };
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
  const url = clientAppLink(options.clientAppUrl, "interaction", {
    ref: options.ref,
  });
  return url === null ? { mode: "address" } : { mode: "launcher", url };
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

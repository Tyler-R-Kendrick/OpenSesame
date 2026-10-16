/**
 * The claim link: `/claim#token=osc_clm_…`, `/claim#token=…&key=…` for a
 * secret drop, and the portable drop's additional `&pkt=…` (ADR 0062).
 *
 * Every half rides the fragment so none reaches a request line, a server log
 * or a `Referer`. The key beside the bearer marks an ordinary drop before its
 * single presentation; a portable bearer or packet marks one even when the
 * key is absent, so the opener can refuse that incomplete link without
 * presenting it. Dispatch is made here, once, for every claim surface.
 */
import { matchCeremonyPath } from "./ceremony-routes.js";

/** `osc_clm_<publicId>.<secret>`, both base64url (os-domain `parseClaimToken`). */
const CLAIM_TOKEN = /^osc_clm_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const PORTABLE_DROP_TOKEN_PREFIX = "osc_pdrop_";
const PORTABLE_DROP_TOKEN = /^osc_pdrop_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

/** Whether `value` has the shape of a claim bearer. Says nothing of validity. */
export function isClaimToken(value: string): boolean {
  return CLAIM_TOKEN.test(value);
}

/** A portable drop bearer carries a 16-byte id and a 32-byte secret. */
export function isPortableDropToken(value: string): boolean {
  return PORTABLE_DROP_TOKEN.test(value);
}

export type ClaimLink =
  | { kind: "claim"; token: string }
  | { kind: "drop"; token: string; key: string; pkt?: string };

function fragmentParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

/**
 * Read a claim link's fragment. A bearer with a key is a drop; a bearer alone
 * is an ownership claim unless it is portable or carries a packet. A portable
 * drop with no key stays a drop arrival with an empty key. Anything else is
 * not a claim link.
 */
export function readClaimLink(hash: string): ClaimLink | null {
  const params = fragmentParams(hash);
  const token = params.get("token");
  if (!token || (!isClaimToken(token) && !isPortableDropToken(token))) {
    return null;
  }
  const key = params.get("key");
  const pkt = params.get("pkt");
  if (key || isPortableDropToken(token) || pkt !== null) {
    return {
      kind: "drop",
      token,
      key: key || "",
      ...(pkt === null ? {} : { pkt }),
    };
  }
  return { kind: "claim", token };
}

/**
 * Whether the fragment carries anything that must leave the address bar: a
 * bearer, drop key or portable packet, well formed or not. Scrubbing on this
 * rather than on `readClaimLink` takes a mangled link out of history too.
 */
export function fragmentCarriesBearer(hash: string): boolean {
  const params = fragmentParams(hash);
  return params.has("token") || params.has("key") || params.has("pkt");
}

/**
 * The complete claim link, RFC 8628's `verification_uri_complete` for a claim:
 * `routeUrl#token=<bearer>`, where `routeUrl` is the claim route that
 * `buildCeremonyUrl(base, "claim")` built.
 *
 * `buildCeremonyUrl` refuses every credential-shaped name in a query or
 * fragment, and must go on refusing them. This is the one narrow exception,
 * and it holds only when its inputs are exactly what it expects: a claim
 * route with no query and no fragment of its own, and a bearer of the claim
 * shape. The bearer rides the fragment, so it never reaches a request line,
 * a server log or a `Referer`; Pages reads it at boot and scrubs it from the
 * address bar (`app-core` `lib/claims/arrival.ts`). Throws on anything else,
 * without naming the bearer.
 */
export function buildClaimLink(routeUrl: string, token: string): string {
  if (!isClaimToken(token)) {
    throw new Error("A claim link needs a claim bearer.");
  }
  let route: URL;
  try {
    route = new URL(routeUrl);
  } catch {
    throw new Error("A claim link needs a claim route URL.");
  }
  if (
    routeUrl.includes("?") ||
    routeUrl.includes("#") ||
    route.username !== "" ||
    route.password !== "" ||
    matchCeremonyPath("claim", route.pathname) === null
  ) {
    throw new Error("A claim link needs a claim route URL.");
  }
  return `${route.href}#token=${token}`;
}

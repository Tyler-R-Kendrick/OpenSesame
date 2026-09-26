/**
 * The claim link: `/claim#token=osc_clm_…`, or `/claim#token=…&key=…` for a
 * secret drop (ADR 0062).
 *
 * Both halves ride the fragment so neither reaches a request line, a server
 * log or a `Referer`. The only client-side signal that a link is a drop before
 * its single presentation is the key beside the bearer — the manifest kind is
 * checked after, inside the decrypt — so the dispatch is made here, once, for
 * every surface that opens a claim link.
 */
import { matchCeremonyPath } from "./ceremony-routes.js";

/** `osc_clm_<publicId>.<secret>`, both base64url (os-domain `parseClaimToken`). */
const CLAIM_TOKEN = /^osc_clm_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Whether `value` has the shape of a claim bearer. Says nothing of validity. */
export function isClaimToken(value: string): boolean {
  return CLAIM_TOKEN.test(value);
}

export type ClaimLink =
  | { kind: "claim"; token: string }
  | { kind: "drop"; token: string; key: string };

function fragmentParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

/**
 * Read a claim link's fragment. A bearer with a key beside it is a drop; a
 * bearer alone is an ownership claim; anything else — no bearer, a key with
 * no bearer, a bearer that is not claim-shaped — is not a claim link.
 */
export function readClaimLink(hash: string): ClaimLink | null {
  const params = fragmentParams(hash);
  const token = params.get("token");
  if (!token || !isClaimToken(token)) return null;
  const key = params.get("key");
  return key ? { kind: "drop", token, key } : { kind: "claim", token };
}

/**
 * Whether the fragment carries anything that must leave the address bar: a
 * bearer or a drop key, well formed or not. Scrubbing on this rather than on
 * `readClaimLink` means a mangled link is still taken out of history.
 */
export function fragmentCarriesBearer(hash: string): boolean {
  const params = fragmentParams(hash);
  return params.has("token") || params.has("key");
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

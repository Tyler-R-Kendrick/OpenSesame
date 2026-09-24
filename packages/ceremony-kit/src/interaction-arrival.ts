import { readFragmentToken } from "./deep-link.js";
import {
  InteractionLinkError,
  parseInteractionUrl,
  parseLegacyInteractionLink,
} from "./interaction-url.js";

/**
 * What an address opened an interaction surface on (ADR 0086, ADR 0140 plan
 * step 5), read without touching a global. Ported from mobile-MFA's
 * `readOpenedLink`: a surface hands in its address and gets back what arrived
 * and the address to put in its place, and applies the second itself
 * (`history.replaceState`, or app-core's page port).
 *
 * The reference in `/i/<ref>` authorizes nothing, but a link is still the
 * least defensible place for anything else to sit: a fragment survives in
 * history and in a shared screenshot, so it always leaves; a query that names
 * credential material leaves whole; and the legacy user code, once read,
 * leaves with the claim id that rode beside it.
 */

export type InteractionArrival =
  /** Not an interaction link. */
  | { kind: "none" }
  /** The canonical `…/i/<ref>` form. */
  | { kind: "interaction"; ref: string }
  /** One of the shapes that predate the canonical form (a device user code). */
  | { kind: "legacy"; userCode: string; claimId?: string }
  /** The link carried credential material and must not be acted on. */
  | { kind: "refused" };

/** What arrived, and the relative address to put in its place (`null`: none). */
export type InteractionArrivalRead = {
  arrival: InteractionArrival;
  scrubbed: string | null;
};

/**
 * The alphabet a claim id must match before a surface will echo it. It only
 * ever appears in a dead-end hint, and pinning it is what stops that hint
 * becoming a place to render somebody else's sentence.
 */
const CLAIM_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Query names a legacy link carried, taken out once read. */
const LEGACY_QUERY = ["user_code", "code", "claim_id"];

function parse(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** `pathname` + what is left of the query, with no fragment. */
function relative(url: URL, search: URLSearchParams | null): string {
  const rest = search?.toString() ?? "";
  return `${url.pathname}${rest ? `?${rest}` : ""}`;
}

function legacyArrival(url: URL, userCode: string): InteractionArrivalRead {
  const claim = url.searchParams.get("claim_id");
  const rest = new URLSearchParams(url.search);
  for (const name of LEGACY_QUERY) rest.delete(name);
  const arrival: InteractionArrival =
    claim !== null && CLAIM_ID.test(claim)
      ? { kind: "legacy", userCode, claimId: claim }
      : { kind: "legacy", userCode };
  return { arrival, scrubbed: relative(url, rest) };
}

/**
 * Read an address: what arrived, and the relative address to replace it with
 * (`null` when nothing has to leave it).
 *
 * Canonical first, legacy second, and nothing else. A fragment is taken out
 * before the canonical parser runs (the parser refuses one rather than
 * repairing it); a fragment carrying `#token=` is a claim bearer pointed at
 * the wrong surface and refuses the link. `parseLegacyInteractionLink` throws
 * when the address names credential material, and that is a refusal too —
 * with the whole query dropped, since no part of such a link is to be acted on.
 */
export function readInteractionArrival(href: string): InteractionArrivalRead {
  const url = parse(href);
  if (url === null) return { arrival: { kind: "none" }, scrubbed: null };
  const carriedFragment = url.hash.length > 0;
  const bearer = carriedFragment && readFragmentToken(url.hash) !== null;
  const unhashed = new URL(url.href);
  unhashed.hash = "";
  const withoutFragment = carriedFragment
    ? relative(url, url.searchParams)
    : null;
  if (bearer)
    return { arrival: { kind: "refused" }, scrubbed: withoutFragment };
  const canonical = parseInteractionUrl(unhashed.href);
  if (canonical !== null) {
    return {
      arrival: { kind: "interaction", ref: canonical.ref },
      scrubbed: withoutFragment,
    };
  }
  try {
    const legacy = parseLegacyInteractionLink(unhashed.href);
    if (legacy !== null) return legacyArrival(url, legacy.userCode);
  } catch (error) {
    if (!(error instanceof InteractionLinkError)) throw error;
    return { arrival: { kind: "refused" }, scrubbed: relative(url, null) };
  }
  return { arrival: { kind: "none" }, scrubbed: withoutFragment };
}

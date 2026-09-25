import { matchCeremonyPath } from "./ceremony-routes.js";
import {
  InteractionLinkError,
  assertNoForbiddenParams,
} from "./interaction-url.js";

/**
 * The approval-review link, `/approve/<ref>` (ADR 0084; ADR 0140 plan step
 * 9), read without touching a global — the bounded, shape-checked parser
 * every surface reads an approve link with, as `readInteractionArrival` is
 * for `/i/<ref>`.
 *
 * The reference is an authorization-request id (`areq_…`) or the handle a
 * rendezvous link carries. It authorizes nothing: every call it opens needs
 * the approver's session. The link carries it in the path and nothing else,
 * so a query or a fragment always leaves the address, and one that names
 * credential material refuses the link whole.
 */

/** URL-safe characters only, bounded: an id, never a path or a query. */
const APPROVAL_REF = /^[A-Za-z0-9_-]{1,128}$/;

/** A query or fragment longer than a link needs is not read, only dropped. */
const MAX_LINK_LENGTH = 2048;

export type ApprovalArrival =
  /** Not an approve link. */
  | { kind: "none" }
  | { kind: "request"; ref: string }
  /** A reference of the wrong shape, or a link that carried credentials. */
  | { kind: "refused" };

/** What arrived, and the relative address to put in its place (`null`: none). */
export type ApprovalArrivalRead = {
  arrival: ApprovalArrival;
  scrubbed: string | null;
};

/** True when `ref` has the shape an approve link may carry. */
export function isApprovalRef(ref: string): boolean {
  return APPROVAL_REF.test(ref);
}

/**
 * The reference at the tail of `pathname`, or `null`. The segment is read
 * raw — never percent-decoded — so an encoded `/` or `..` is refused by the
 * shape check instead of being repaired into something else.
 */
export function approvalRefAt(pathname: string): string | null {
  const ref = matchCeremonyPath("approve", pathname)?.ref;
  return ref !== undefined && isApprovalRef(ref) ? ref : null;
}

/** Whether the query or fragment names credential material (fails closed). */
function carriesCredentials(href: string): boolean {
  try {
    assertNoForbiddenParams(href);
    return false;
  } catch (error) {
    if (error instanceof InteractionLinkError) return true;
    throw error;
  }
}

/**
 * Read an address: an approve link's reference, and the bare path to put in
 * its place when a query or fragment rode along. An address that is not an
 * approve path is `none` and left alone.
 */
export function readApprovalArrival(href: string): ApprovalArrivalRead {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { arrival: { kind: "none" }, scrubbed: null };
  }
  if (matchCeremonyPath("approve", url.pathname) === null) {
    return { arrival: { kind: "none" }, scrubbed: null };
  }
  const scrubbed = url.search || url.hash ? url.pathname : null;
  const ref = approvalRefAt(url.pathname);
  const suspect =
    scrubbed !== null &&
    (href.length > MAX_LINK_LENGTH || carriesCredentials(href));
  if (ref === null || suspect) {
    return { arrival: { kind: "refused" }, scrubbed };
  }
  return { arrival: { kind: "request", ref }, scrubbed };
}

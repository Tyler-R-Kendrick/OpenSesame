import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Opaque handles shared by the interaction and authorization-request surfaces.
 *
 * These derivations are the address space the cross-device layer is built on
 * (ADR 0086) and they must be byte-identical wherever they are computed: a
 * requester holding one `inbox_…` address has to reach the same principal on
 * the interaction handoff, on the authorization-request inbox, and — the
 * reason this module exists — on the subject-settlement executor that
 * recomputes a request digest from a stored interaction. A second, drifting
 * copy of any of these would let a handle verify on one surface and fail on
 * another, and whichever was laxer would become the one attackers use.
 *
 * Nothing here is secret; integrity comes from the deployment pepper keying
 * the MAC, and from comparing a presented handle against a freshly derived
 * one in constant time.
 */

/**
 * An opaque handle for whoever is asking.
 *
 * The canonical principal id does not travel here: this value reaches an
 * approver's screen and crosses bus subjects that are not private (ADR 0042
 * subject hygiene). The purpose string is shared with the authorization-request
 * inbox so one requester has one handle across both surfaces.
 */
export function requesterRef(principalId: string, pepper: string): string {
  return `req_${createHash("sha256")
    .update(`opensesame:requester-ref:v1\0${pepper}\0${principalId}`)
    .digest("base64url")
    .slice(0, 24)}`;
}

/**
 * The handle that addresses an inbox.
 *
 * Knowing the handle is what authorizes the asking. It is the principal id
 * carried under an HMAC keyed by the deployment pepper, so it cannot be minted
 * for an id the caller was never handed a handle for.
 */
export function inboxRef(principalId: string, pepper: string): string {
  const body = Buffer.from(principalId, "utf8").toString("base64url");
  const tag = createHmac("sha256", pepper)
    .update(`opensesame:inbox-ref:v1\0${principalId}`)
    .digest("base64url")
    .slice(0, 32);
  return `inbox_${body}.${tag}`;
}

/**
 * The principal an `inbox_…` handle addresses, or null if it was not minted
 * here.
 *
 * A handle that does not verify and a handle for a principal that no longer
 * exists both answer null, so callers can collapse them to one 404 and leave
 * no oracle to query.
 */
export function resolveInboxRef(ref: string, pepper: string): string | null {
  if (!ref.startsWith("inbox_")) return null;
  const [body, tag] = ref.slice("inbox_".length).split(".");
  if (!body || !tag) return null;
  let principalId: string;
  try {
    principalId = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!principalId) return null;
  const expected = inboxRef(principalId, pepper);
  // Constant-time: the tag is a MAC, and a byte-by-byte compare with an early
  // exit is a forgery oracle for a caller who can time the answer.
  const a = Buffer.from(ref, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return principalId;
}

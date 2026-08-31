/**
 * The digest that makes an approval mean something (ADR 0086).
 *
 * Everything else in the interaction layer is plumbing. This file is the
 * invariant:
 *
 *     displayed operation == approved operation == executed operation
 *
 * A WebAuthn assertion proves a key was touched. A verifiable presentation
 * proves a credential was held. Neither says *what was agreed to*. The digest
 * is what carries that, and an executor that does not recompute it before
 * running has an approval system in name only.
 *
 * This is PSD2 dynamic linking — Commission Delegated Regulation (EU) 2018/389,
 * RTS Article 5: the authentication code must be specific to the amount and the
 * payee shown to the payer, and any change to either invalidates it —
 * generalized from payments to arbitrary operations. It is also the fix for
 * SSH agent forwarding's original defect, where a signature request never said
 * what it was for (and which OpenSSH answered in 8.9 with destination
 * constraints for the same reason).
 *
 * Canonicalization rules, and why each one is load-bearing:
 *
 * - **Length-prefixed fields.** Without a length prefix, moving text across a
 *   field boundary produces the same byte stream: a payee of `"AliceCo"` with
 *   reference `"123"` and a payee of `"AliceCo123"` with an empty reference
 *   would hash identically, and an attacker who controls one field controls
 *   the other's meaning.
 * - **Sorted object keys.** Two encoders that disagree about key order would
 *   otherwise produce two digests for one request, and the check would fail
 *   for honest callers — which ends, every time, with somebody relaxing it.
 * - **Preserved array order.** `authorization_details` is a list of things
 *   being permitted; reordering it does not change the set, but sorting it
 *   here would mean a request could be reordered *and* mutated in one step
 *   with only the mutation visible.
 * - **The expiry window is inside the digest.** An approval is for an
 *   operation *and* for how long it stays good. Leaving the window out would
 *   let a requester approve a five-minute grant and execute an eight-hour one.
 */

import { createHash } from "node:crypto";
import type { AuthorizationDetail } from "../authorization-details.js";
import { canonicalize } from "./digest.js";

export const REQUEST_DIGEST_PURPOSE = "opensesame:interaction-request:v1";

/**
 * Exactly the fields an approval is bound to.
 *
 * Deliberately closed. A future field that ought to be covered must be added
 * here and versioned in the purpose string, because silently widening what is
 * hashed breaks every digest already stored, and silently *narrowing* it is
 * how a system grows a field the user sees and the executor ignores.
 */
export interface CanonicalRequest {
  /** Which kind of question this is. A payment approval must not settle a claim. */
  kind: string;
  /**
   * The ceremony this approval settles, as `kind:id`.
   *
   * In the digest because an approval is for *this* operation on *this*
   * record. Two interactions can legitimately carry identical details — the
   * same call against the same connection, raised twice — and without the
   * subject their digests would collide, so a proof gathered for one would
   * satisfy the other. That is approval transfer, and the fact that no caller
   * currently resolves an interaction by subject is a property of today's
   * call sites rather than of the digest.
   */
  subject: string;
  /** Opaque handle for the approver. Never a canonical principal id. */
  approverRef: string;
  /** Opaque handle for the requester. */
  requesterRef: string;
  authorizationDetails: readonly AuthorizationDetail[];
  /** The sentence shown on both screens. */
  bindingMessage: string;
  /** Opaque handle for the target, when the operation has one. */
  resourceRef?: string;
  /** The end of the approval's validity, as an ISO-8601 instant. */
  expiresAt: string;
}

function field(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value, "utf8")));
  hash.update("\0");
  hash.update(value, "utf8");
}

/**
 * The canonical digest of a request.
 *
 * Unkeyed on purpose. A MAC would make the digest unverifiable by anyone but
 * the minting service, and the whole point is that an independent executor —
 * the holder's own daemon, in the relay case of ADR 0046 — can recompute it
 * from the request it is about to run and compare. There is nothing secret in
 * a digest, and its integrity comes from being compared to a stored value, not
 * from being unforgeable in isolation.
 */
export function canonicalRequestDigest(request: CanonicalRequest): string {
  const hash = createHash("sha256");
  field(hash, REQUEST_DIGEST_PURPOSE);
  field(hash, request.kind);
  field(hash, request.subject);
  field(hash, request.approverRef);
  field(hash, request.requesterRef);
  field(hash, canonicalize([...request.authorizationDetails]));
  field(hash, request.bindingMessage);
  field(hash, request.resourceRef ?? "");
  field(hash, request.expiresAt);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Compare a recomputed digest with an approved one.
 *
 * A plain `===` would be correct here — a digest is public, so a timing
 * side-channel leaks nothing an attacker cannot compute themselves. It is
 * written as an explicit, total function anyway so that every call site reads
 * as a decision rather than as an incidental equality, and so there is exactly
 * one place to change if that reasoning ever stops holding.
 */
export function digestMatches(approved: string, executable: string): boolean {
  return approved.length === executable.length && approved === executable;
}

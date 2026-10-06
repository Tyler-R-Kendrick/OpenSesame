/**
 * Building an `ApprovalProof` from what the server established, and refusing
 * one a client tried to fabricate (ADR 0086 §7).
 *
 * The first implementation of the approve route took the whole `ApprovalProof`
 * from the request body. An adversarial review showed the consequence: an
 * authenticated caller could write `mechanism: "webauthn"`,
 * `assurance: "phishing_resistant"` into storage and the audit trail having
 * touched no key at all, and the repository's own test helper did exactly
 * that with every test green. A record that overstates what was checked is
 * worse than no record, because it is the record a reviewer believes.
 *
 * So there are two halves here, and they are deliberately separate:
 *
 * - `sealApprovalProof` is the *only* way to make a `SealedApprovalProof`, the
 *   one type `interactionMachine.approve` accepts. Every
 *   field of the result comes from a server-established fact — the mechanism
 *   the route verified, the digest it stored, the assurance read from the
 *   approver's principal record, the server's own clock. Nothing a client
 *   sent reaches it.
 * - `assertOnlyDigestEcho` is what the route runs on the request body first.
 *   The only thing a client may send is the digest it was shown, so it can be
 *   compared against the stored one; anything else — a mechanism, an
 *   assurance, a timestamp, a credential handle, a bound digest — is
 *   fabrication and is refused by name.
 */

import { DomainError } from "./errors.js";
import {
  type JsonValue,
  isString,
  isTypeofObject,
  overlapCast,
} from "./json.js";

// The one constructor, and the sealed type it makes, live under `proofs/`
// (ADR 0178); they are re-exported here so the entry points do not move.
export {
  type SealedApprovalProof,
  type ServerEstablishedApproval,
  sealApprovalProof,
} from "./proofs/approval-seal.js";

/**
 * What a client may send when approving: the digest it was shown, and — at
 * most — the id of an activation the authority already verified for this
 * interaction.
 *
 * Everything else about an approval is server-derived. `activationId` is not a
 * proof and not a claim about a mechanism; it is an opaque handle the server
 * minted when it verified a transaction-scoped step-up, and the server reads
 * the mechanism and assurance from *that* record, never from the client. So
 * the accepted body names an activation but never describes it. This is the
 * domain-level statement of the same rule `ApproveInteractionSchema` enforces
 * at the wire edge.
 */
// A `type` alias rather than an `interface` on purpose: `assertOnlyDigestEcho`
// narrows a `JsonValue` to this shape, and an assertion predicate's target
// must be assignable to its parameter. A type alias of an object literal
// carries the implicit string index signature that makes it a `JsonObject`
// (and so a `JsonValue`); an interface does not, and the predicate would not
// typecheck.
export type ClientApprovalEcho = {
  requestDigest: string;
  activationId?: string;
};

/** Fields a legitimate approval body may carry. Everything else is refused. */
const PERMITTED_FIELDS: readonly string[] = ["requestDigest", "activationId"];

/**
 * Field names a fabricated proof tries to smuggle in.
 *
 * Named explicitly so the refusal can say *which* field was the fabrication,
 * which is the difference between a log line a reviewer can act on and a bare
 * "invalid request".
 */
const FABRICATED_FIELDS: readonly string[] = [
  "mechanism",
  "assurance",
  "verifiedAt",
  "credentialRef",
  "boundDigest",
  "proof",
  "approvalProof",
  "approverPrincipalId",
];

export class FabricatedProofRefused extends DomainError {
  constructor(field: string) {
    super(
      "INVARIANT_VIOLATION",
      `approval carries a server-derived field it may not set: ${field}`,
      { field },
    );
    this.name = "FabricatedProofRefused";
  }
}

/**
 * Refuse an approval body that carries anything but the digest echo.
 *
 * Runs before the digest is even compared, because the point is not "this
 * value is wrong" but "the client is not allowed to have an opinion here at
 * all". A body that names a mechanism or an assurance is rejected whatever it
 * says, so the assurance level in the audit trail can only ever be the one the
 * server read from the principal record.
 */
export function assertOnlyDigestEcho(
  body: JsonValue,
): asserts body is ClientApprovalEcho {
  if (!isTypeofObject(body) || body === null || Array.isArray(body)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "approval body must be an object carrying the request digest",
    );
  }
  /*
   * SAFETY: the guard above established `body` is a non-null, non-array object,
   * so `Object.entries` is total over it and each key is a string.
   */
  const record = overlapCast(body);
  for (const [key] of Object.entries(record)) {
    if (FABRICATED_FIELDS.includes(key)) {
      throw new FabricatedProofRefused(key);
    }
    if (!PERMITTED_FIELDS.includes(key)) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        `approval body carries an unexpected field: ${key}`,
      );
    }
  }
  const digest = record.requestDigest;
  if (!isString(digest) || digest.length === 0) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "approval body must carry a non-empty request digest to echo",
    );
  }
}

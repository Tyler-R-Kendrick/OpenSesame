/**
 * Verify a digest-bound payment approval (CONSENT stub).
 *
 * Mirrors Identity-plane `assertOnlyDigestEcho` / `sealApprovalProof`: a
 * caller may not mint assurance by writing `mechanism: "webauthn"` into a
 * proof object. Without verified assertion bytes the server (or this stub)
 * established, those strings are fabrication and are refused by name.
 *
 * This stub does not yet verify cryptographic signatures over
 * `verifiedBytes`; it only requires that verified bytes exist before any
 * mechanism/assurance claim is admitted, and that `boundDigest` matches.
 */

/** What a proof may carry after a real verifier ran. */
export interface DigestBoundPaymentProof {
  /** Digest the activation / approval was bound to. */
  boundDigest: string;
  /**
   * Assertion (or equivalent) bytes the verifier actually checked.
   * Absent or empty → no claim about mechanism/assurance is admissible.
   */
  verifiedBytes?: Uint8Array;
  /** Caller-supplied label — never sufficient alone. */
  mechanism?: string;
  /** Caller-supplied assurance label — never sufficient alone. */
  assurance?: string;
}

export type DigestBoundApprovalRefusal =
  | "digest_mismatch"
  | "missing_verified_bytes"
  | "unverified_assurance";

export type DigestBoundApprovalResult =
  | { ok: true }
  | { ok: false; reason: DigestBoundApprovalRefusal };

export interface VerifyDigestBoundApprovalInput {
  expectedDigest: string;
  proof: DigestBoundPaymentProof;
}

function hasVerifiedBytes(proof: DigestBoundPaymentProof): boolean {
  return (
    proof.verifiedBytes !== undefined && proof.verifiedBytes.byteLength > 0
  );
}

/**
 * Admit a proof only when the digest matches and verified bytes are present.
 *
 * Caller-supplied `mechanism` / `assurance` strings without verified bytes are
 * always refused (`unverified_assurance`), including the classic
 * `mechanism: "webauthn"` forgery.
 */
export function verifyDigestBoundApproval(
  input: VerifyDigestBoundApprovalInput,
): DigestBoundApprovalResult {
  const { expectedDigest, proof } = input;

  if (proof.boundDigest !== expectedDigest) {
    return { ok: false, reason: "digest_mismatch" };
  }

  if (!hasVerifiedBytes(proof)) {
    if (proof.mechanism !== undefined || proof.assurance !== undefined) {
      return { ok: false, reason: "unverified_assurance" };
    }
    return { ok: false, reason: "missing_verified_bytes" };
  }

  return { ok: true };
}

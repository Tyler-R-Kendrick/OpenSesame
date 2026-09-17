/**
 * Verify a digest-bound payment approval.
 * Caller-written mechanism/assurance strings are never evidence.
 */

import { verifyPaymentApprovalSignature } from "./keys.js";

export interface DigestBoundPaymentProof {
  boundDigest: string;
  verifiedBytes?: Uint8Array;
  publicKeySpki?: Uint8Array;
  mechanism?: string;
  assurance?: string;
}

export type DigestBoundApprovalRefusal =
  | "digest_mismatch"
  | "missing_verified_bytes"
  | "unverified_assurance"
  | "signature_invalid";

export type DigestBoundApprovalResult =
  | { ok: true; verifiedMechanism: "es256" }
  | { ok: false; reason: DigestBoundApprovalRefusal };

export interface VerifyDigestBoundApprovalInput {
  expectedDigest: string;
  proof: DigestBoundPaymentProof;
}

export function verifyDigestBoundApproval(
  input: VerifyDigestBoundApprovalInput,
): DigestBoundApprovalResult {
  const { expectedDigest, proof } = input;
  if (proof.boundDigest !== expectedDigest) {
    return { ok: false, reason: "digest_mismatch" };
  }
  const hasBytes =
    proof.verifiedBytes !== undefined && proof.verifiedBytes.byteLength > 0;
  const hasKey =
    proof.publicKeySpki !== undefined && proof.publicKeySpki.byteLength > 0;
  if (!hasBytes || !hasKey) {
    if (proof.mechanism !== undefined || proof.assurance !== undefined) {
      return { ok: false, reason: "unverified_assurance" };
    }
    return { ok: false, reason: "missing_verified_bytes" };
  }
  if (
    !verifyPaymentApprovalSignature(
      expectedDigest,
      proof.verifiedBytes as Uint8Array,
      proof.publicKeySpki as Uint8Array,
    )
  ) {
    return { ok: false, reason: "signature_invalid" };
  }
  return { ok: true, verifiedMechanism: "es256" };
}

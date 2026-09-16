/**
 * Wallet spending consent — digest-bound payment approval (CONSENT swarm).
 *
 * Additive to Identity-plane interaction handoff. Does not replace
 * `canonicalRequestDigest` or weaken approve/deny routes; those remain the
 * ceremony envelope. This package digests executable payment terms and
 * refuses forged assurance labels without verified assertion bytes.
 */

export {
  PAYMENT_APPROVAL_DIGEST_VERSION,
  type PaymentApprovalIntent,
  buildPaymentApprovalDigest,
} from "./digest.js";
export {
  type DigestBoundApprovalRefusal,
  type DigestBoundApprovalResult,
  type DigestBoundPaymentProof,
  type VerifyDigestBoundApprovalInput,
  verifyDigestBoundApproval,
} from "./verify.js";

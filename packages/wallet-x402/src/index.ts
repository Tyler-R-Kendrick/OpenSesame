/**
 * @opensesame/wallet-x402 — bounded x402 exact-payment foundation.
 *
 * No mainnet. No real facilitator accounts. Adapter local_execution stays blocked
 * until a harness lands evidence under docs/evidence/wallet/.
 */

export {
  assessX402Adapter,
  describeX402Adapter,
  executeX402Payment,
  prepareX402Payment,
  reconcileX402Payment,
  X402_ADAPTER_BLOCKED_REASON,
  X402AdapterBlockedError,
} from "./adapter.js";
export { assessExactPayment } from "./assess.js";
export { matchChallenge } from "./challenge.js";
export {
  PREALLOCATED_PURSE_RESIDUAL_RISK,
  type AssessExactPaymentInput,
  type AssessRefusalCode,
  type ChallengeMatchErr,
  type ChallengeMatchOk,
  type ChallengeMatchResult,
  type ChallengeMismatchCode,
  type EvidenceStatus,
  type ExactPaymentApproved,
  type ExactPaymentAssessment,
  type ExactPaymentProfile,
  type ResourceBinding,
  type X402AdapterManifest,
  type X402PaymentRequirement,
  type X402Scheme,
} from "./types.js";

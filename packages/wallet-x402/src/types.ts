/**
 * x402 exact-payment profile types.
 *
 * Depends on wallet-policy enforcement shapes. DOM (`os-domain` wallet)
 * PaymentIntent / SpendingLease are not re-exported from `@opensesame/os-domain`
 * yet; assessment inputs stay profile-local and structurally compatible.
 */

import type {
  AmountUnits,
  ConstraintEnforcement,
  EnforcementAuthority,
} from "@opensesame/wallet-policy";

/** Adapter / profile evidence ladder (mirrors DOM `EvidenceStatus`). */
export type EvidenceStatus =
  | "specified"
  | "source_inspected"
  | "fixture_verified"
  | "local_execution_verified"
  | "target_deployment_verified"
  | "blocked";

/** Only `exact` is admitted by this package. */
export type X402Scheme = "exact" | "upto";

/**
 * Explicit residual-risk copy for `preallocated_purse` assessments.
 * Allocation/balance exposure only — not recipient or period enforcement.
 */
export const PREALLOCATED_PURSE_RESIDUAL_RISK =
  "preallocated_purse residual risk: bound is allocation/balance exposure only; an unrestricted purse key holder is not independently constrained for recipient, period, or calendar rules";

/** HTTP resource binding for challenges that do not bind on-chain. */
export type ResourceBinding = {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly bodyCommitment?: string;
};

/**
 * Approved exact-payment bounds. Merchant display names are not destinations.
 */
export type ExactPaymentApproved = {
  readonly chainId: string;
  readonly tokenContract: string;
  readonly recipient: string;
  readonly amount: AmountUnits;
  readonly resource: ResourceBinding;
};

/**
 * Compiled exact profile. Scheme is fixed to `exact` at the type level.
 */
export type ExactPaymentProfile = {
  readonly id: "x402-exact";
  readonly scheme: "exact";
  readonly protocolVersion: string;
  readonly approved: ExactPaymentApproved;
  readonly authority: EnforcementAuthority;
  readonly maxRetries: number;
  readonly maxBillableAttempts: number;
  readonly maxChallengeAlternatives: number;
  /** When true, assess refuses — refill must be a new digest. */
  readonly allowImplicitRefill: false;
  /** When true, assess refuses — Permit2 is out of the exact profile. */
  readonly allowPermit2: false;
};

/** Wire-shaped payment requirement / challenge alternative. */
export type X402PaymentRequirement = {
  readonly scheme: string;
  readonly network: string;
  readonly chainId: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxAmountRequired: AmountUnits;
  readonly extra?: {
    readonly permit2?: boolean;
    readonly allowance?: boolean;
    readonly refill?: boolean;
  };
};

export type ChallengeMismatchCode =
  | "CHALLENGE_SCHEME_MISMATCH"
  | "CHALLENGE_CHAIN_MISMATCH"
  | "CHALLENGE_TOKEN_MISMATCH"
  | "CHALLENGE_RECIPIENT_MISMATCH"
  | "CHALLENGE_AMOUNT_MISMATCH";

export type ChallengeMatchOk = {
  readonly ok: true;
};

export type ChallengeMatchErr = {
  readonly ok: false;
  readonly code: ChallengeMismatchCode;
  readonly expected: string;
  readonly actual: string;
};

export type ChallengeMatchResult = ChallengeMatchOk | ChallengeMatchErr;

export type AssessRefusalCode =
  | "SCHEME_UPTO_REFUSED"
  | "PERMIT2_REFUSED"
  | "ALLOWANCE_PATH_REFUSED"
  | "IMPLICIT_REFILL_REFUSED"
  | "UNBOUNDED_CHALLENGE_ALTERNATIVES"
  | ChallengeMismatchCode;

export type ExactPaymentAssessment = {
  readonly profileId: "x402-exact";
  readonly accepted: boolean;
  readonly evidenceStatus: EvidenceStatus;
  readonly productionEnabled: false;
  readonly refusals: readonly AssessRefusalCode[];
  readonly constraints: readonly ConstraintEnforcement[];
  readonly assumptions: readonly string[];
  readonly residualRisks: readonly string[];
};

export type X402AdapterManifest = {
  readonly adapterId: "x402-exact";
  readonly packageName: "@opensesame/wallet-x402";
  readonly protocol: "x402";
  readonly supportedSchemes: readonly ["exact"];
  readonly evidenceStatus: EvidenceStatus;
  readonly productionEnabled: false;
  readonly blockedReason: string;
  readonly sdkPins: {
    readonly core: "@x402/core@2.26.0";
    readonly evm: "@x402/evm@2.26.0";
    readonly protocolVersion: number;
  };
  readonly headers: {
    readonly paymentRequired: "PAYMENT-REQUIRED";
    readonly paymentSignature: "PAYMENT-SIGNATURE";
    readonly paymentResponse: "PAYMENT-RESPONSE";
  };
};

export type AssessExactPaymentInput = {
  readonly profile: ExactPaymentProfile;
  readonly challenge: X402PaymentRequirement;
  readonly alternatives?: readonly X402PaymentRequirement[];
};

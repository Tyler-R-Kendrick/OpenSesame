import type { AmountUnits } from "./amount.js";

/** Validated opaque identifier; never a free-form display label. */
export type WalletRef = string;

/** Hex or base64url digest string bound into approvals and enforcement. */
export type WalletDigest = string;

/**
 * Asset identity. Tickers are untrusted labels — fiat uses ISO currency +
 * exponent; tokens bind chain, contract, decimals, and deployment fingerprint.
 */
export type AssetRef =
  | {
      readonly kind: "fiat";
      readonly currency: string;
      readonly exponent: number;
    }
  | {
      readonly kind: "token";
      readonly chainId: string;
      readonly contract: string;
      readonly decimals: number;
      readonly deploymentFingerprint: WalletDigest;
    };

/**
 * Spending window. Fixed-interval duration and calendar semantics stay distinct;
 * calendar activation requires matching independent enforcement.
 */
export type BudgetWindow =
  | {
      readonly kind: "lifetime";
      readonly validFrom: string;
      readonly validUntil: string;
    }
  | {
      readonly kind: "fixed_interval";
      readonly anchor: string;
      readonly durationSeconds: string;
      readonly validUntil: string;
      readonly rollover: "none";
    }
  | {
      readonly kind: "calendar";
      readonly unit: "day" | "month";
      readonly timeZone: string;
      readonly boundaryScheduleRef: WalletRef;
      readonly validUntil: string;
      readonly rollover: "none";
    };

export type EnforcementAuthority =
  | {
      readonly kind: "local_broker";
      readonly origin: string;
      readonly buildDigest: WalletDigest;
    }
  | {
      readonly kind: "contract";
      readonly chainId: string;
      readonly account: string;
      readonly manager: string;
      readonly sharedRootRef: WalletRef;
      readonly deploymentManifestRef: WalletRef;
    }
  | {
      readonly kind: "preallocated_purse";
      readonly allocationRef: WalletRef;
      readonly accountRef: WalletRef;
    }
  | {
      readonly kind: "escrow";
      readonly channelRef: WalletRef;
      readonly deploymentManifestRef: WalletRef;
    }
  | {
      readonly kind: "owner_service";
      readonly connectionRef: WalletRef;
      readonly ledgerNamespace: WalletRef;
    }
  | {
      readonly kind: "issuer";
      readonly connectionRef: WalletRef;
      readonly instrumentRef: WalletRef;
    };

export type ConstraintEnforcementResult =
  | "enforced"
  | "approval_only"
  | "unsupported";

export type ConstraintEnforcement = {
  readonly constraintRef: WalletRef;
  readonly requestedDigest: WalletDigest;
  readonly effectiveDigest: WalletDigest;
  readonly result: ConstraintEnforcementResult;
  readonly authority?: EnforcementAuthority;
  readonly assumptions: readonly string[];
  readonly evidenceRefs: readonly WalletRef[];
};

export type EvidenceStatus =
  | "specified"
  | "source_inspected"
  | "fixture_verified"
  | "local_execution_verified"
  | "target_deployment_verified"
  | "blocked";

export type WalletAccount = {
  readonly id: WalletRef;
  readonly ownerPrincipalRef: WalletRef;
  readonly domainRef: WalletRef;
  readonly fundingConnectionRefs: readonly WalletRef[];
  readonly custodyProfileRef: WalletRef;
  readonly recoveryProfileRef: WalletRef;
};

export type RequiredEnforcement = "local_approval" | "independent_execution";

export type RefundPolicy =
  | "no_automatic_restore"
  | "restore_after_verified_refund";

export type BudgetPolicy = {
  readonly id: WalletRef;
  readonly version: string;
  readonly walletRef: WalletRef;
  readonly parentBudgetRef?: WalletRef;
  readonly asset: AssetRef;
  readonly ceiling: AmountUnits;
  readonly window: BudgetWindow;
  readonly feePolicyRef: WalletRef;
  readonly refundPolicy: RefundPolicy;
  readonly requiredEnforcement: RequiredEnforcement;
};

export type BudgetPeriodStatus = "open" | "closing" | "closed" | "superseded";

/** Inclusive start, exclusive end — one open period per policy version/asset. */
export type BudgetPeriod = {
  readonly id: WalletRef;
  readonly budgetPolicyRef: WalletRef;
  readonly policyVersion: string;
  readonly asset: AssetRef;
  readonly window: BudgetWindow;
  readonly ceiling: AmountUnits;
  readonly rootAccountingRef: WalletRef;
  readonly status: BudgetPeriodStatus;
};

export type BudgetAllocationStatus =
  | "proposed"
  | "active"
  | "exhausted"
  | "revocation_pending"
  | "revoked"
  | "expired";

export type BudgetAllocation = {
  readonly id: WalletRef;
  readonly budgetPeriodRef: WalletRef;
  readonly parentAllocationRef?: WalletRef;
  readonly amount: AmountUnits;
  readonly beneficiaryRef: WalletRef;
  readonly authorityRef: WalletRef;
  readonly version: string;
  readonly status: BudgetAllocationStatus;
  readonly rootAccountingRef: WalletRef;
};

/**
 * Temporary spending pass backed by an allocation. Distinct from TrustSession,
 * VaultSession, workload identity, and a provider PaymentSession.
 */
export type SpendingLeaseStatus =
  | "active"
  | "stop_requested"
  | "revocation_pending"
  | "revoked"
  | "expired";

export type SpendingLease = {
  readonly id: WalletRef;
  /** Existing grant lineage — not a second ACL. */
  readonly grantRef: WalletRef;
  readonly allocationRef: WalletRef;
  readonly policyVersion: string;
  readonly beneficiaryRef: WalletRef;
  readonly actorInstanceRef?: WalletRef;
  readonly proofKeyThumbprint: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly requiredEnforcementDigest: WalletDigest;
  readonly effectiveEnforcementDigest: WalletDigest;
  readonly rootAccountingRef: WalletRef;
  readonly status: SpendingLeaseStatus;
};

/** Provider or rail payment session — not a SpendingLease. */
export type PaymentSession = {
  readonly id: WalletRef;
  readonly providerRef: WalletRef;
  readonly leaseRef: WalletRef;
  readonly externalSessionRef: string;
  readonly validUntil?: string;
};

export type LocalIntentStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "cancelled";

export type ExecutionStatus =
  | "not_started"
  | "reserved"
  | "authorized"
  | "submitted"
  | "unknown";

export type SettlementStatus =
  | "none"
  | "pending"
  | "settled"
  | "definitively_failed"
  | "reorganized";

export type AuthorityLifecycleStatus =
  | "active"
  | "stop_requested"
  | "revocation_pending"
  | "revoked"
  | "expired";

export type RecoveryStatus =
  | "none"
  | "claim_pending"
  | "refund_pending"
  | "recovered"
  | "disputed";

export type PaymentLifecycle = {
  readonly localIntent: LocalIntentStatus;
  readonly execution: ExecutionStatus;
  readonly settlement: SettlementStatus;
  readonly authority: AuthorityLifecycleStatus;
  readonly recovery: RecoveryStatus;
};

export type PaymentIntentStatus = LocalIntentStatus;

export type PaymentIntent = {
  readonly id: WalletRef;
  readonly walletRef: WalletRef;
  readonly domainRef: WalletRef;
  readonly leaseRef: WalletRef;
  readonly allocationRef: WalletRef;
  readonly asset: AssetRef;
  readonly amount: AmountUnits;
  readonly feeCeiling: AmountUnits;
  readonly destinationRef: WalletRef;
  readonly requesterPrincipalRef: WalletRef;
  readonly proofKeyThumbprint: string;
  readonly policyVersion: string;
  readonly protocolProfileRef: WalletRef;
  readonly requestCommitment: WalletDigest;
  readonly idempotencyScope: string;
  readonly requiredEnforcement: RequiredEnforcement;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly status: PaymentIntentStatus;
  readonly rootAccountingRef: WalletRef;
};

export type PaymentAttemptStatus =
  | "open"
  | "reserved"
  | "submitted"
  | "unknown"
  | "settled"
  | "failed"
  | "released";

export type PaymentAttempt = {
  readonly id: WalletRef;
  readonly intentRef: WalletRef;
  readonly attemptKey: string;
  readonly reservedAmount: AmountUnits;
  readonly feeExposure: AmountUnits;
  readonly status: PaymentAttemptStatus;
  readonly lifecycle: PaymentLifecycle;
  readonly createdAt: string;
};

export type ReservationStatus = "held" | "committed" | "released" | "expired";

export type Reservation = {
  readonly id: WalletRef;
  readonly attemptRef: WalletRef;
  readonly allocationRef: WalletRef;
  readonly amount: AmountUnits;
  readonly feeExposure: AmountUnits;
  readonly status: ReservationStatus;
  readonly rootAccountingRef: WalletRef;
  readonly createdAt: string;
};

/** Sessions that must remain distinct product concepts. */
export type SessionKind =
  | "trust"
  | "vault"
  | "workload"
  | "spending_lease"
  | "payment_session";

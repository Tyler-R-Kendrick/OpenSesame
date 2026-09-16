/**
 * Payment-adapter boundary types (wallet spending directive).
 *
 * DOM (`packages/os-domain/src/wallet/`) may later own shared AmountUnits /
 * PaymentIntent records; until then this package carries the minimal shapes
 * the EVM adapter needs.
 */

/** Opaque reference string used across wallet packages. */
export type Ref = string;

/** Content digest (hex or multibase); not a secret. */
export type Digest = string;

/** Smallest currency subunit as a non-negative integer. Never float. */
export type AmountUnits = bigint;

export type EvidenceStatus =
  | "specified"
  | "source_inspected"
  | "fixture_verified"
  | "local_execution_verified"
  | "target_deployment_verified"
  | "blocked";

export type EnforcementAuthority =
  | { kind: "local_broker"; origin: string; buildDigest: Digest }
  | {
      kind: "contract";
      chainId: string;
      account: string;
      manager: string;
      sharedRootRef: Ref;
      deploymentManifestRef: Ref;
    }
  | { kind: "preallocated_purse"; allocationRef: Ref; accountRef: Ref }
  | { kind: "escrow"; channelRef: Ref; deploymentManifestRef: Ref }
  | { kind: "owner_service"; connectionRef: Ref; ledgerNamespace: Ref }
  | { kind: "issuer"; connectionRef: Ref; instrumentRef: Ref };

export type ConstraintEnforcement = {
  constraintRef: Ref;
  requestedDigest: Digest;
  effectiveDigest: Digest;
  result: "enforced" | "approval_only" | "unsupported";
  assumptions: string[];
  evidenceRefs: Ref[];
  authority?: EnforcementAuthority;
};

export type AdapterConstraintSupport = {
  constraintId: string;
  authority: EnforcementAuthority["kind"] | "none";
  unitsOrTimeSemantics: string;
  knownBypassPaths: readonly string[];
};

export type AdapterDeploymentIdentity = {
  chainId: string;
  genesisHash: string | null;
  addresses: Readonly<Record<string, string>>;
  bytecodeFingerprints: Readonly<Record<string, string>>;
  managerVersion: string | null;
  enforcerVersions: Readonly<Record<string, string>>;
  upgradeAdminControl: string;
};

/**
 * Runtime readiness is independent of evidenceStatus.
 * Do not collapse these into a single `productionReady` boolean.
 */
export type AdapterReadiness =
  | { kind: "ready" }
  | { kind: "not_configured"; detail: string }
  | { kind: "blocked"; detail: string }
  | { kind: "awaiting_harness"; detail: string }
  | { kind: "stale"; detail: string };

export type AdapterManifest = {
  adapterId: string;
  packageName: string;
  packageVersion: string;
  protocolVersions: readonly string[];
  /** Candidate or pinned upstream source commit (hex). */
  sourceCommit: string;
  sourceLicense: string;
  evidenceStatus: EvidenceStatus;
  /**
   * Must stay false until docs/evidence/wallet/ holds verified command output.
   * An activation flag cannot manufacture deployment evidence.
   */
  productionEnabled: boolean;
  browserRuntimeRequirements: readonly string[];
  mandatoryExternalComponents: readonly string[];
  supportedMechanisms: readonly string[];
  supportedAssets: readonly string[];
  supportedNetworks: readonly string[];
  supportedConstraints: readonly AdapterConstraintSupport[];
  keyArrangement: string;
  independentlyEnforcedScope: string;
  privilegedModules: readonly string[];
  deploymentIdentity: AdapterDeploymentIdentity | null;
  revocationSemantics: string;
  outstandingAuthorizationBehavior: string;
  closureRecoveryRules: string;
  maxUnresolvedExposureAccounting: string;
  verificationAssumptions: readonly string[];
  readiness: AdapterReadiness;
};

export type AdapterContext = {
  origin: string;
  /** Wall-clock assist for display only; never authoritative for hostile limits. */
  nowIso: string;
};

/** ERC-20 quirks this profile refuses until proven (WAL-E10). */
export type Erc20TransferSemantics =
  | "standard"
  | "fee_on_transfer"
  | "rebase"
  | "callback"
  | "unusual_return"
  | "upgradeable";

export type AssetRef =
  | { kind: "fiat"; currency: string; exponent: number }
  | {
      kind: "token";
      chainId: string;
      contract: string;
      decimals: number;
      deploymentFingerprint: Digest;
      /** Absent means standard transfer; non-standard refuses activation. */
      transferSemantics?: Erc20TransferSemantics;
    };

export type PaymentIntent = {
  id: Ref;
  walletRef: Ref;
  leaseRef: Ref;
  allocationRef: Ref;
  destinationRef: Ref;
  asset: AssetRef;
  amount: AmountUnits;
  maxFeeExposure: AmountUnits;
  requestCommitment: Digest;
  requesterRef: Ref;
  expectedProofKeyThumbprint: string;
  protocolProfileVersion: string;
  validFrom: string;
  validUntil: string;
  idempotencyScope: string;
  requiredEnforcement: "local_approval" | "independent_execution";
  executionEnvironment: string;
};

export type SpendingLease = {
  id: Ref;
  grantRef: Ref;
  allocationRef: Ref;
  policyVersion: string;
  beneficiaryRef: Ref;
  proofKeyThumbprint: string;
  validFrom: string;
  validUntil: string;
  requiredEnforcementDigest: Digest;
  effectiveEnforcementDigest: Digest;
  rootAccountingRef: Ref;
  actorInstanceRef?: Ref;
};

export type WalletAdapterErrorCode =
  | "REQUIRED_CONSTRAINT_UNSUPPORTED"
  | "PERIOD_SEMANTICS_UNSUPPORTED"
  | "INDEPENDENT_ENFORCEMENT_UNAVAILABLE"
  | "ACCOUNTING_AUTHORITY_UNAVAILABLE"
  | "AUTHORITY_NOT_CONFIGURED"
  | "CALLER_NOT_AUTHORIZED";

export type EnforcementAssessment =
  | {
      kind: "refused";
      code: WalletAdapterErrorCode;
      detail: string;
      evidenceStatus: EvidenceStatus;
      unsupportedConstraints: readonly string[];
      residualExposures: readonly string[];
      requiredServices: readonly string[];
      keyCustodyTrust: string;
      assumptions: readonly string[];
    }
  | {
      kind: "assessed";
      constraints: readonly ConstraintEnforcement[];
      evidenceStatus: EvidenceStatus;
      residualExposures: readonly string[];
      requiredServices: readonly string[];
      keyCustodyTrust: string;
      assumptions: readonly string[];
    };

/** Opaque reserved+approved intent resolved by the broker — never caller-minted. */
export type ReservedApprovedIntent = {
  ref: Ref;
  intentId: Ref;
  leaseId: Ref;
  /** Stable shared constrained ancestor used for aggregate spend accounting. */
  rootAccountingRef: Ref;
  amount: AmountUnits;
  destinationRef: Ref;
  expiresAt: string;
};

export type PreparedExecutionRef = {
  ref: Ref;
  intentId: Ref;
  expiresAt: string;
  singleUseToken: Digest;
};

export type ExecutionObservation = {
  attemptRef: Ref;
  status: "submitted" | "confirmed" | "failed" | "unknown";
  detail: string;
  evidenceRefs: readonly Ref[];
};

export type PaymentAttemptRef = { ref: Ref };

export type ReconciliationObservation = {
  attemptRef: Ref;
  status: "matched" | "pending" | "divergent" | "unknown";
  detail: string;
  evidenceRefs: readonly Ref[];
};

export type SpendingAuthorityRef = { ref: Ref };

export type RevocationObservation = {
  authorityRef: Ref;
  status: "revoked" | "pending" | "unavailable";
  detail: string;
  evidenceRefs: readonly Ref[];
};

/**
 * Typed payment adapter boundary. Discovery describes what a configured
 * adapter can actually do — not what its ecosystem might eventually support.
 */
export interface PaymentAdapter {
  describe(context: AdapterContext): Promise<AdapterManifest>;
  assess(
    intent: PaymentIntent,
    lease: SpendingLease,
  ): Promise<EnforcementAssessment>;
  prepare(input: ReservedApprovedIntent): Promise<PreparedExecutionRef>;
  execute(prepared: PreparedExecutionRef): Promise<ExecutionObservation>;
  reconcile(attempt: PaymentAttemptRef): Promise<ReconciliationObservation>;
  requestStop(authority: SpendingAuthorityRef): Promise<RevocationObservation>;
}

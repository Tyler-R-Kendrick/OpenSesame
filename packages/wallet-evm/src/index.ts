/**
 * @opensesame/wallet-evm — EVM payment adapter foundation.
 *
 * Candidate MetaMask delegation-framework pin:
 * bff4b08f8006ad94322a6e3da8d90f274e20325d (see README).
 * Real contract tests: wallet:test:contracts (BUILD harness; not here).
 */

export type {
  AdapterConstraintSupport,
  AdapterContext,
  AdapterDeploymentIdentity,
  AdapterManifest,
  AdapterReadiness,
  AmountUnits,
  AssetRef,
  ConstraintEnforcement,
  Digest,
  EnforcementAssessment,
  EnforcementAuthority,
  EvidenceStatus,
  ExecutionObservation,
  PaymentAdapter,
  PaymentAttemptRef,
  PaymentIntent,
  PreparedExecutionRef,
  ReconciliationObservation,
  Ref,
  ReservedApprovedIntent,
  RevocationObservation,
  SpendingAuthorityRef,
  SpendingLease,
  WalletAdapterErrorCode,
} from "./types.js";

export {
  InMemorySharedAncestorCounter,
  type SharedAncestorSpendResult,
} from "./simulation.js";

export {
  createDirectErc20DelegationAdapter,
  DELEGATION_FRAMEWORK_CANDIDATE_COMMIT,
  DIRECT_ERC20_DELEGATION_ADAPTER_ID,
  type DirectErc20DelegationMode,
  type DirectErc20DelegationOptions,
} from "./direct-erc20-delegation.js";

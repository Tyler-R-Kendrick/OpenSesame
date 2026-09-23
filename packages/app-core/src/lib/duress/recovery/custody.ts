/**
 * Recovery barrel — re-exports roles, approval quorum, Shamir shares, ceremony.
 * Kept as `custody.ts` for compat with `duress.test.ts` and RECOVERY report layout.
 */

export type {
  CustodyAction,
  CustodyGrant,
  CustodyRole,
} from "./roles.js";
export {
  assertOutsideCompartmentCustody,
  countIndependentApprovers,
  countIndependentCustodians,
  roleAllows,
} from "./roles.js";

export type {
  ApprovalOutcome,
  QuorumConfig,
  RecoveryApproval,
  RecoveryRequest,
  TargetDeviceChallenge,
  TargetDeviceProof,
} from "./approval.js";
export {
  ApprovalQuorumLedger,
  digestRecoveryRequest,
  issueTargetDeviceChallenge,
  proveTargetDevice,
  sealApproval,
  verifyTargetDeviceProof,
} from "./approval.js";

export type { ShareContextExpect, ShareEnvelope } from "./shares.js";
export {
  LocalShareMaterialGuard,
  combineRecoveryShares,
  splitRecoverySecret,
  verifyShareEnvelope,
} from "./shares.js";

export type { CeremonyResult, GenerationRegistry } from "./ceremony.js";
export {
  assertGenerationLive,
  authorizeReenrollment,
  createGenerationRegistry,
  reconstructAfterQuorum,
  replaceKeyCustodian,
  reportApprovalQuorum,
  revokeGeneration,
  rotateGeneration,
  runAvailabilityDrill,
} from "./ceremony.js";

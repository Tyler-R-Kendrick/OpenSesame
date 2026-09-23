/**
 * Presentation projection entrypoints (COMPARTMENT-UX).
 * Cryptographic admission via session keys — not cosmetic filters (INV-05).
 */

export type { PresentationClass } from "../access/context.js";
export {
  createKeyedCompartment,
  updateDecoyContents,
  buildTopology,
  requireIndependentPresentation,
  openPublishedCompartment,
  type CompartmentItem,
  type CompartmentKind,
  type CompartmentPlaintext,
  type PublishedCompartment,
} from "./registry.js";
export {
  mintPresentationSession,
  openPresentation,
  tryOpenWithForeignKey,
  type AdmittedKey,
  type OpenOutcome,
  type PresentationSession,
} from "./session.js";
export {
  projectScopedView,
  projectConnectorRefs,
  itemPreview,
  totpActionAllowed,
  passkeyActionAllowed,
  attachmentPreviewAllowed,
  admittedSwitcherTargets,
  accessibleProjection,
  assertNoProtectedLeak,
  type ScopedView,
  type ScopeQuery,
} from "./scope.js";
export {
  decideConnectorAttach,
  approveSafeLowAuthorityConnection,
  type SafeConnectionApproval,
  type ConnectorDecision,
} from "./connectors.js";
export {
  previewLimitedCarryExposure,
  buildLimitedCarryPlan,
  materializeLimitedCarry,
  restoreLimitedCarryOffline,
  type LimitedCarryPlan,
  type LimitedCarryBundle,
} from "./limited-carry.js";
export {
  importCompartmentKey,
  sealCompartmentJson,
  openCompartmentJson,
  type SealedCompartmentBlob,
} from "./seal.js";
export {
  projectVisibleItems,
  projectCounts,
  decoyConnectorAllowed,
  projectConnectors,
  resolveDecoyOrLocked,
  selectLimitedCarry,
  projectLimitedCarry,
  canRestoreLimitedCarry,
  assertNoCrossCompartmentLeak,
  type VaultItemView,
  type ProjectionQuery,
  type LimitedCarrySelection,
} from "./compat.js";

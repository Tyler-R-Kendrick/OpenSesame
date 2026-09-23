/**
 * BUILD swarm: opt-in duress feature registration, offline readiness, format refusal.
 */

export {
  DURESS_CAPABILITIES,
  capabilitiesForMode,
  capabilityIdsForMode,
  unsupportedCapabilitiesForMode,
  type DuressCapability,
  type DuressCapabilityId,
} from "./registry.js";

export {
  DURESS_READER_VERSION,
  type DuressFeatureMode,
  isDuressFeatureEnabled,
} from "./types.js";

export {
  compareDuressModes,
  compareFeatureModes,
  enrollmentAssetReadiness,
  loadDuressRuntime,
  registerDuressFeature,
  resolveDuressMode,
  type DuressAssetReadiness,
  type DuressFeatureRegistration,
  type LoadDuressRuntimeResult,
} from "./mode.js";

export {
  assertReadableDuressHeader,
  explainFormatRefusal,
  refuseUnsupportedDuressFormat,
  type DuressFormatHeader,
  type FormatRefusal,
} from "./format.js";

export {
  DuressOfflineAssetCache,
  evaluateOfflineAssetReadiness,
  type AssuranceLevel,
  type AssetProbe,
  type OfflineAssetEntry,
  type OfflineReadinessReport,
} from "./assets.js";

export {
  DURESS_STATIC_CONSTRAINTS,
  checkStaticHostingConstraints,
  type StaticConstraintProbe,
  type StaticConstraintReport,
} from "./static.js";

export {
  clampAssuranceForSw,
  evaluateServiceWorkerMismatch,
  type SwAssetManifest,
  type SwMismatchReport,
} from "./sw-mismatch.js";

export * from "./types.js";
export type {
  Diagnostic,
  DiagnosticCode,
  ParseResult,
  ValidationResult,
} from "./diagnostics.js";
export { DIAGNOSTIC_CODES, MAX_DIAGNOSTICS } from "./diagnostics.js";
export {
  MAX_ID_LENGTH,
  MAX_MODULE_ID_LENGTH,
  MAX_OPAQUE_ID_LENGTH,
  MAX_REVISION_LENGTH,
  compareIds,
  isCapabilityId,
  isModuleId,
  isOpaqueId,
  isUnitName,
  moduleCapability,
  sortIds,
} from "./ids.js";
export {
  DIGEST_PREFIX,
  DIGEST_RE,
  type PlanDigestBody,
  canonicalize,
  digestOf,
  exposureDigest,
  planDigest,
  receiptDigest,
  sha256Hex,
  sortConflicts,
} from "./canonical.js";
export {
  MAX_CATALOG_CAPABILITIES,
  MAX_DEPENDENCY_DEPTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  type CatalogIndex,
  buildCatalog,
  indexCatalog,
  validateCatalog,
} from "./catalog.js";
export {
  parseInstallationSelection,
  parseInstancePolicy,
  parseVaultSelection,
  parseWorkspaceRestriction,
} from "./documents.js";
export {
  parseConsentReceipt,
  parseDistributionContract,
} from "./documents-runtime.js";
export { MAX_LIST_IDS } from "./parse-fields.js";
export type { ResolveInput } from "./resolve-input.js";
export {
  NO_SELECTION_REVISION,
  PERSONAL_LOCAL_INSTANCE,
  PERSONAL_LOCAL_NETWORK,
  PERSONAL_LOCAL_REVISION,
} from "./resolve-axes.js";
export { explainCapability, resolveComposition } from "./resolve.js";
export { diagnoseRuntimeDocuments } from "./diagnose.js";
export { reviewCompositionChange } from "./review.js";
export {
  type ConsentCandidates,
  buildConsentReceipt,
  computeConsentDelta,
  consentCandidatesOf,
} from "./consent.js";
export { BLOCKING_REASONS, REASON_CODES, sortReasons } from "./reasons.js";
export {
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_FACTS,
  FIXTURE_INSTALLATION,
  FIXTURE_INSTALLATION_ID,
  FIXTURE_POLICIES,
  fixtureResolveInput,
  fixtureSelection,
} from "./fixtures.js";

/**
 * @opensesame/capability-composition — pure semantic contracts for
 * operator-controlled capability composition.
 *
 * Zero runtime dependencies except `@opensesame/os-domain`; no DOM, React,
 * fetch, clock, storage or crypto primitives. The FNV-1a digest here is a
 * deterministic change-detector, not a security boundary.
 */

export * from "./ids.js";
export * from "./descriptor.js";
export {
  validateInstancePolicy,
  validateVaultRestriction,
  validateInstallationSelection,
  DOCUMENT_LIMITS,
  type InstancePolicyDocument,
  type VaultRestrictionDocument,
  type InstallationSelectionDocument,
  type NetworkPolicy,
  type UpdatesPolicy,
  type PolicyDocumentBase,
  type ExplicitAllowSet,
  type AllowSet,
  type DocumentValidationFailure,
  type DocumentValidation,
} from "./documents.js";
export * from "./resolver.js";
export type { Ceiling, Node } from "./resolver-graph.js";
export type { NodeContext, NodeEvaluation } from "./resolver-node.js";
export * from "./digest.js";
export * from "./explain.js";
export * from "./lifecycle.js";
export * from "./presets.js";

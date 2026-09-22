/**
 * Resolver output and lifecycle contracts for capability composition: the
 * effective plan, explanations, change review, leases, registrars and the
 * admission decision. Types only; the Pages runtime implements them.
 */

import type {
  BrowserPermission,
  CapabilityId,
  CapabilityTier,
  EgressDeclaration,
  ModuleId,
  OperationId,
} from "./types-catalog.js";
import type { NetworkPolicy, PolicyProvenance } from "./types-documents.js";

// ---------------------------------------------------------------------------
// Effective plan
// ---------------------------------------------------------------------------

export type ReasonCode =
  | "CORE"
  | "NOT_DISTRIBUTED"
  | "PROHIBITED_BY_INSTANCE"
  | "NOT_PERMITTED_BY_INSTANCE"
  | "DENIED_BY_WORKSPACE"
  | "DISABLED_IN_VAULT"
  | "NOT_SELECTED"
  | "REQUIRED_NOT_ACCEPTED"
  | "CONSENT_REQUIRED"
  | "DEPENDENCY_CONFLICT"
  | "ALTERNATIVE_NOT_CHOSEN"
  | "UNSUPPORTED_RUNTIME"
  | "POLICY_UNVERIFIED"
  | "PROFILE_MISMATCH"
  | "NETWORK_POLICY_DENIES"
  | "WORKER_GRAPH_UNAVAILABLE"
  | "NOT_CACHED_OFFLINE"
  | "RESTART_REQUIRED";

/**
 * Independent axes. A capability may be permitted but unselected, selected
 * but unavailable, available but uncached, and so on. No single boolean.
 */
export type CapabilityState = Readonly<{
  id: CapabilityId;
  tier: CapabilityTier;
  distributed: boolean;
  permitted: boolean;
  required: boolean;
  /** Selected as a root by the installation or accepted as required. */
  selected: boolean;
  /** Pulled in as a dependency of a selected root (not a root itself). */
  dependencyOf: readonly CapabilityId[];
  /** Runtime prerequisites hold in the supplied facts. */
  runtimeSupported: boolean;
  /** In the approved closure: loadable and invokable under this plan. */
  approved: boolean;
  /** Evaluated in this realm although no longer approved. */
  restartRequired: boolean;
  reasons: readonly ReasonCode[];
}>;

export type PlanConflict = Readonly<{
  code:
    | "DEPENDENCY_PROHIBITED"
    | "DEPENDENCY_NOT_DISTRIBUTED"
    | "DEPENDENCY_NOT_PERMITTED"
    | "ALTERNATIVE_NOT_CHOSEN"
    | "ALTERNATIVE_NOT_ALLOWED"
    | "REQUIRED_PROHIBITED"
    | "REQUIRED_NOT_DISTRIBUTED"
    | "NETWORK_POLICY_DENIES"
    | "WORKER_GRAPH_UNAVAILABLE";
  capability: CapabilityId;
  /** The dependency, alternative, or slot the conflict is about. */
  subject: string;
  message: string;
}>;

export type PlanIdentity = Readonly<{
  instanceId: string;
  installationId: string;
  vaultId: string | null;
  distributionId: string;
  policyRevision: string;
  selectionRevision: string;
  planDigest: string;
}>;

/** What consent is still owed before the plan can be committed/activated. */
export type ConsentDelta = Readonly<{
  /** Roots newly selected that have never been accepted. */
  addedRoots: readonly CapabilityId[];
  /** Roots present in the receipt but no longer selected. */
  removedRoots: readonly CapabilityId[];
  /** Capabilities in the closure whose exposure digest changed since receipt. */
  changedExposure: readonly CapabilityId[];
  /** Dependencies newly pulled into the closure since receipt. */
  addedDependencies: readonly CapabilityId[];
  /** Required roots not yet accepted (joining is refused until they are). */
  requiredNotAccepted: readonly CapabilityId[];
}>;

export type EffectivePlan = Readonly<{
  identity: PlanIdentity;
  provenance: PolicyProvenance;
  policyValid: boolean;
  /** Every catalog capability, keyed by id, with every axis populated. */
  capabilities: Readonly<Record<CapabilityId, CapabilityState>>;
  /** Approved closure (roots + dependencies), sorted. */
  approvedCapabilities: readonly CapabilityId[];
  /** Modules eligible for `loadApprovedModule`, sorted. */
  approvedModules: readonly ModuleId[];
  /** Operations whose capability prerequisite is satisfied, sorted. */
  approvedOperations: readonly OperationId[];
  /** Item kinds whose creation surfaces may appear, sorted. */
  approvedItemKinds: readonly string[];
  /** The worker variant the installation must run, or null for core-only. */
  requiredWorkerVariant: string | null;
  conflicts: readonly PlanConflict[];
  consent: ConsentDelta;
  /** The network envelope the approved closure may use. */
  network: NetworkPolicy;
}>;

/** What `explainCapability` returns for a person or a diagnostic view. */
export type CapabilityExplanation = Readonly<{
  id: CapabilityId;
  state: CapabilityState;
  /** Chain of capabilities that made this one part of the closure. */
  via: readonly CapabilityId[];
  conflicts: readonly PlanConflict[];
}>;

// ---------------------------------------------------------------------------
// Change review
// ---------------------------------------------------------------------------

export type CompositionChangeReview = Readonly<{
  before: PlanIdentity;
  after: PlanIdentity;
  enabled: readonly CapabilityId[];
  disabled: readonly CapabilityId[];
  addedModules: readonly ModuleId[];
  removedModules: readonly ModuleId[];
  addedOperations: readonly OperationId[];
  removedOperations: readonly OperationId[];
  /** New egress classes/purposes the after-plan may use and the before could not. */
  addedEgress: readonly EgressDeclaration[];
  addedPermissions: readonly BrowserPermission[];
  /** Worker variant transition, if any. */
  workerTransition: Readonly<{ from: string | null; to: string | null }> | null;
  /** Capabilities that need a reload once enabled. */
  requiresDocumentReload: readonly CapabilityId[];
  /** True when the after-plan needs a worker variant this build lacks. */
  requiresNewArtifact: boolean;
  /** Modules already evaluated in this realm that the after-plan excludes. */
  restartRequiredFor: readonly ModuleId[];
  conflicts: readonly PlanConflict[];
  consent: ConsentDelta;
  /** Monotonicity check: a tightening must never enlarge the approved set. */
  widened: boolean;
}>;

// ---------------------------------------------------------------------------
// Lifecycle contracts (types only; the Pages runtime implements them)
// ---------------------------------------------------------------------------

/**
 * Authority to load and activate under one plan. `generation` increments on
 * every committed change, lock, vault switch, or revocation; `signal` aborts
 * when the lease is invalidated. A lease never outlives its plan identity.
 */
export type ActivationLease = Readonly<{
  identity: PlanIdentity;
  generation: number;
  signal: AbortSignal;
}>;

export type ContributionKind =
  | "section"
  | "route"
  | "settings-category"
  | "setup-panel"
  | "command-path"
  | "keymap-jump"
  | "tutorial-target"
  | "tutorial-goal"
  | "tutorial-route"
  | "item-kind"
  | "webmcp-tool"
  | "background-job"
  | "unlock-effect";

/** A revocable handle returned by every registrar. Idempotent `revoke`. */
export type RegistrationHandle = Readonly<{
  kind: ContributionKind;
  capability: CapabilityId;
  generation: number;
  revoke: () => void;
}>;

/** Returned by a runtime's `activate`; disposed on any lease invalidation. */
export type RuntimeHandle = Readonly<{
  capability: CapabilityId;
  dispose: () => void | Promise<void>;
}>;

/**
 * Lifecycle status a UI may show. These are distinct claims and none of them
 * implies another (P-TRUTH).
 */
export type CapabilityLifecycle =
  | "not-distributed"
  | "not-selected"
  | "consent-required"
  | "approved-not-loaded"
  | "loading"
  | "active"
  | "disabled"
  | "disabled-restart-required"
  | "cached-offline"
  | "revocation-pending";

/**
 * Cross-context admission result for a sensitive operation. `admitted: false`
 * when the durable committed generation is newer than the caller's, or when
 * cross-context serialization could not be established (fail closed).
 */
export type AdmissionDecision = Readonly<{
  admitted: boolean;
  committedGeneration: number;
  reason: "current" | "stale-generation" | "no-serialization" | "not-approved";
}>;

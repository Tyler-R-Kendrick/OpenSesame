/**
 * Canonical contracts for operator-controlled capability composition.
 *
 * Everything here is data or a type. Nothing imports the DOM, React, a
 * framework, a feature implementation, storage, or a network client. The
 * resolver in `resolve.ts` is pure over these shapes; runtimes (the Pages
 * loader, the service-worker controller, the OpenFeature projection, the
 * configuration editors) consume them and never redefine them.
 *
 * Four identifier universes, kept distinct on purpose (see
 * docs/implementation/capability-composition/ownership.md):
 *
 * - **capability ID** — an installable product function a person selects.
 * - **operation ID** — an existing `@opensesame/capability-registry` action.
 *   Never renamed here; a capability *owns* operations, it is not one.
 * - **module ID** — an executable implementation unit the loader can fetch.
 * - **asset ID** — an emitted build resource (chunk, CSS, worker, file).
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** `vault.passwords`, `connectors.external`, `enterprise.ca-administration`. */
export type CapabilityId = string;
/** An `@opensesame/capability-registry` id, e.g. `pages.settings.prefs.edit`. */
export type OperationId = string;
/** `connectors.external/section`, `agents.webmcp/runtime`. */
export type ModuleId = string;
/** A build-emitted path relative to the distribution root. */
export type AssetId = string;

// ---------------------------------------------------------------------------
// Descriptors (bounded data, never code)
// ---------------------------------------------------------------------------

export type ExecutionEnvironment =
  | "document"
  | "dedicated-worker"
  | "shared-worker"
  | "service-worker";

/**
 * Whether a capability may be chosen at all.
 * - `core`: always present in every distribution and plan; cannot be
 *   prohibited, deselected, or removed. Listed so its exposure is declared.
 * - `optional`: default off; requires explicit selection and consent.
 */
export type CapabilityTier = "core" | "optional";

export type EgressClass =
  | "application-assets"
  | "external-service"
  | "peer-or-local-network"
  | "user-mediated-navigation";

/** A declared destination class. `origins` are patterns for review copy only. */
export type EgressDeclaration = Readonly<{
  class: EgressClass;
  /** Short human description, e.g. "the configured Identity API". */
  purpose: string;
  /** Whether traffic can start without a person's direct action. */
  automatic: boolean;
}>;

export type BrowserPermission =
  | "notifications"
  | "camera"
  | "microphone"
  | "clipboard-write"
  | "persistent-storage"
  | "webauthn"
  | "web-share"
  | "file-system-access";

export type KeyAccessClass =
  | "none"
  | "item-plaintext"
  | "protector-wrap"
  | "provider-bearer";

/**
 * One alternative implementation path for a dependency. A capability may
 * depend on exactly one of several alternatives (e.g. sharing over an
 * Identity-API drop versus a future local transport). Selecting one requires
 * reviewing that concrete alternative; nothing falls back automatically.
 */
export type DependencyAlternatives = Readonly<{
  /** Stable name of the requirement, e.g. "transport". */
  slot: string;
  /** Capability IDs that can satisfy the slot. Order is display order only. */
  oneOf: readonly CapabilityId[];
}>;

export type CapabilityDescriptor = Readonly<{
  id: CapabilityId;
  descriptorVersion: number;
  tier: CapabilityTier;
  title: string;
  summary: string;
  /** Hard dependencies: every one must be permitted and selected/accepted. */
  dependencies: readonly CapabilityId[];
  /** Alternative slots: exactly one per slot must be explicitly selected. */
  alternatives: readonly DependencyAlternatives[];
  operationIds: readonly OperationId[];
  moduleIds: readonly ModuleId[];
  environments: readonly ExecutionEnvironment[];
  egress: readonly EgressDeclaration[];
  browserPermissions: readonly BrowserPermission[];
  keyAccess: KeyAccessClass;
  /** True when the feature needs an Identity/Host/daemon/native component. */
  requiresService: boolean;
  /** One sentence on what works offline; "" when nothing changes offline. */
  offlineLimits: string;
  /**
   * Which service-worker graph this capability needs; `null` for none. Only
   * capabilities with a non-null value participate in installation-wide
   * worker selection.
   */
  workerGraphConstraint: string | null;
  /** Whether enabling it after boot needs a document reload. */
  requiresDocumentReload: boolean;
  /** Vault item kinds this capability owns (creation surfaces, parsers). */
  itemKinds: readonly string[];
  /**
   * Digest over the *declared* exposure (dependencies, alternatives, egress,
   * permissions, key access, environments, modules, worker constraint). It is
   * what a consent receipt binds; a change to any of those produces a review
   * delta. Computed by `exposureDigest()`; a descriptor whose stored value
   * does not match is invalid.
   */
  exposureDigest: string;
}>;

/** The whole authored catalog, validated as a unit. */
export type CapabilityCatalog = Readonly<{
  catalogVersion: number;
  capabilities: readonly CapabilityDescriptor[];
}>;

// ---------------------------------------------------------------------------
// Distribution contract (immutable per release)
// ---------------------------------------------------------------------------

export type DistributionMode = "selective" | "hardened";

export type WorkerVariant = Readonly<{
  /** Stable id, e.g. "core-only", "push". */
  id: string;
  /** Same-origin script URL relative to the base, e.g. "sw.js". */
  scriptPath: string;
  /** Worker-graph constraints this variant satisfies (see descriptor). */
  satisfies: readonly string[];
}>;

export type DistributionContract = Readonly<{
  distributionId: string;
  mode: DistributionMode;
  /** Every capability whose implementation is present in this build. */
  capabilityIds: readonly CapabilityId[];
  /** Every module the generated loader table can import. */
  moduleIds: readonly ModuleId[];
  workerVariants: readonly WorkerVariant[];
  /** Base path the build was emitted under, e.g. "/OpenSesame/". */
  basePath: string;
}>;

// ---------------------------------------------------------------------------
// Policy and selection documents
// ---------------------------------------------------------------------------

export type ExternalServicesPolicy = "allow" | "deny";

export type NetworkPolicy = Readonly<{
  externalServices: ExternalServicesPolicy;
  /** Origins an operator allows when externalServices is "allow". */
  allowedServiceOrigins: readonly string[];
}>;

export type UpdatesPolicy = Readonly<{
  unknownCapabilities: "deny";
  expandedExposure: "require-approval";
}>;

export type PresetProvenance = Readonly<{ id: string; version: number }>;

/**
 * Operator scope. `capabilities.default` is always `deny`: optional
 * capabilities not listed in `optional` or `required` are prohibited by
 * omission, and `prohibited` names the ones an operator wants recorded as a
 * deliberate refusal (so a later preset cannot quietly add them).
 */
export type InstanceCapabilityPolicy = Readonly<{
  schemaVersion: 1;
  kind: "InstanceCapabilityPolicy";
  instanceId: string;
  revision: string;
  presetProvenance: PresetProvenance | null;
  capabilities: Readonly<{
    default: "deny";
    required: readonly CapabilityId[];
    optional: readonly CapabilityId[];
    prohibited: readonly CapabilityId[];
  }>;
  network: NetworkPolicy;
  updates: UpdatesPolicy;
}>;

/**
 * Optional narrowing for one tomb/workspace. `allow: null` inherits the
 * instance ceiling; `allow: []` permits none of the optional capabilities.
 * Both meanings are never given to one value.
 */
export type WorkspaceCapabilityRestriction = Readonly<{
  schemaVersion: 1;
  kind: "WorkspaceCapabilityRestriction";
  instanceId: string;
  vaultId: string;
  revision: string;
  allow: readonly CapabilityId[] | null;
  prohibited: readonly CapabilityId[];
}>;

export type DeliveryPreference = Readonly<{
  prefetch: "none" | "selected";
  offlineCache: "shell-only" | "selected-only";
}>;

/**
 * Device/browser-installation scope. Explicit empty `selectedOptional` means
 * "no optional roots", never "inherit". `acceptedRequired` must list every
 * required root of `basePolicyRevision` for the installation to be joined.
 */
export type InstallationCapabilitySelection = Readonly<{
  schemaVersion: 1;
  kind: "InstallationCapabilitySelection";
  instanceId: string;
  installationId: string;
  basePolicyRevision: string;
  revision: string;
  acceptedRequired: readonly CapabilityId[];
  selectedOptional: readonly CapabilityId[];
  /** slot → chosen alternative, for every alternatives slot in the closure. */
  chosenAlternatives: Readonly<Record<string, CapabilityId>>;
  delivery: DeliveryPreference;
}>;

/** Further narrowing inside one vault session; never widens the installation. */
export type VaultCapabilitySelection = Readonly<{
  schemaVersion: 1;
  kind: "VaultCapabilitySelection";
  instanceId: string;
  installationId: string;
  vaultId: string;
  revision: string;
  disabled: readonly CapabilityId[];
}>;

/** Where a policy document came from; shown to people, never inferred. */
export type PolicyProvenance =
  | "personal-local"
  | "same-origin-deployment"
  | "signed-import"
  | "invitation-unverified";

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * What a person actually accepted: the exact roots plus the exposure digest
 * of every capability in the closure at acceptance time. Checkboxes are not a
 * receipt; this is.
 */
export type ConsentReceipt = Readonly<{
  schemaVersion: 1;
  instanceId: string;
  installationId: string;
  policyRevision: string;
  selectionRevision: string;
  acceptedAt: string;
  roots: readonly CapabilityId[];
  /** capability → exposureDigest accepted. */
  exposure: Readonly<Record<CapabilityId, string>>;
  /** Digest over the normalized receipt body (`receiptDigest()`). */
  receiptDigest: string;
}>;

// ---------------------------------------------------------------------------
// Runtime facts (passed in; never read by the resolver itself)
// ---------------------------------------------------------------------------

export type RuntimeFacts = Readonly<{
  /** Execution environments the current realm can host. */
  environments: readonly ExecutionEnvironment[];
  /** Whether `navigator.serviceWorker` exists and is usable here. */
  serviceWorkerAvailable: boolean;
  /** Worker variant currently controlling the installation, if any. */
  activeWorkerVariant: string | null;
  /** Whether this realm is a fresh document (no optional code evaluated). */
  cleanRealm: boolean;
  /** Module ids already evaluated in this realm (for RESTART_REQUIRED). */
  evaluatedModuleIds: readonly ModuleId[];
  /** ISO 8601 evaluation time, supplied explicitly. */
  now: string;
}>;

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

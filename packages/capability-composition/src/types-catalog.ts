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

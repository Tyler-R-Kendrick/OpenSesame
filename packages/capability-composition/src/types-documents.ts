/**
 * Policy, selection, consent and runtime-fact documents for capability
 * composition. See `types-catalog.ts` for identifiers and descriptors and
 * `types-plan.ts` for the resolver output; `types.ts` re-exports all three.
 */

import type {
  CapabilityId,
  ExecutionEnvironment,
  ModuleId,
} from "./types-catalog.js";

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

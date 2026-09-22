/**
 * The store's mutable state record and the document-scoping rules over it:
 * which policy applies and whether it is valid, and which persisted
 * documents belong to this installation. A document scoped to another
 * installation or instance is dropped with a diagnostic — never adopted,
 * never merged.
 */

import {
  type CapabilityCatalog,
  type CapabilityId,
  type ConsentReceipt,
  type DistributionContract,
  type InstallationCapabilitySelection,
  type InstanceCapabilityPolicy,
  PERSONAL_LOCAL_INSTANCE,
  type PolicyProvenance,
  type RuntimeFacts,
  type VaultCapabilitySelection,
} from "@opensesame/capability-composition";
import type { ParsedRuntimeConfig } from "../runtime-config.js";
import type { PersistedDocs } from "./store-persist.js";

export type StoreState = {
  catalog: CapabilityCatalog | null;
  distribution: DistributionContract | null;
  installationId: string;
  vaultId: string | null;
  provenance: PolicyProvenance;
  policy: InstanceCapabilityPolicy | null;
  policyValid: boolean;
  selection: InstallationCapabilitySelection | null;
  receipt: ConsentReceipt | null;
  vaultSelection: VaultCapabilitySelection | null;
  emergencyDisabled: Set<CapabilityId>;
  baseFacts: RuntimeFacts | null;
  committedGeneration: number;
  generation: number;
};

export type Note = (message: string) => void;

export type ManagedPolicyReview = Readonly<{
  ok: boolean;
  diagnostics: readonly string[];
}>;

export function initialState(): StoreState {
  return {
    catalog: null,
    distribution: null,
    installationId: "",
    vaultId: null,
    provenance: "personal-local",
    policy: null,
    policyValid: true,
    selection: null,
    receipt: null,
    vaultSelection: null,
    emergencyDisabled: new Set(),
    baseFacts: null,
    committedGeneration: 0,
    generation: 0,
  };
}

/** The instance id as the resolver derives it (policy, then selection, then personal-local). */
export function instanceIdOf(
  state: StoreState,
  planInstanceId: string | undefined,
): string {
  return (
    planInstanceId ??
    state.policy?.instanceId ??
    state.selection?.instanceId ??
    PERSONAL_LOCAL_INSTANCE
  );
}

/**
 * Which policy governs this boot. An invalid runtime-config section or an
 * invalid local policy is `policyValid: false` — a core-only plan — never a
 * fall-through to "no policy".
 */
export function readPolicy(
  state: StoreState,
  config: ParsedRuntimeConfig,
  docs: PersistedDocs,
  reviewManaged: (policy: InstanceCapabilityPolicy) => ManagedPolicyReview,
  note: Note,
): void {
  const section = config.capabilityComposition;
  if (config.status === "invalid") {
    state.provenance = section ? "same-origin-deployment" : "personal-local";
    state.policy = null;
    state.policyValid = false;
    note("runtime config invalid: core-only plan until it is fixed");
    return;
  }
  if (section?.instancePolicy) {
    const review = reviewManaged(section.instancePolicy);
    state.provenance = "same-origin-deployment";
    state.policy = section.instancePolicy;
    state.policyValid = review.ok;
    for (const d of review.diagnostics) note(d);
    return;
  }
  state.provenance = "personal-local";
  if (docs.localPolicy.present && docs.localPolicy.policy === null) {
    state.policy = null;
    state.policyValid = false;
    note("local policy invalid: core-only plan until it is repaired");
    return;
  }
  state.policy = docs.localPolicy.policy;
  state.policyValid = true;
}

export function scopedSelection(
  state: StoreState,
  selection: InstallationCapabilitySelection | null,
  note: Note,
): InstallationCapabilitySelection | null {
  if (!selection) return null;
  if (
    selection.installationId !== state.installationId ||
    (state.policy && selection.instanceId !== state.policy.instanceId)
  ) {
    note("selection: scoped to another installation; ignored");
    return null;
  }
  return selection;
}

export function scopedVaultSelection(
  state: StoreState,
  docs: PersistedDocs,
  note: Note,
): VaultCapabilitySelection | null {
  const v = docs.vaultSelection;
  if (!v) return null;
  if (
    v.installationId !== state.installationId ||
    v.vaultId !== state.vaultId
  ) {
    note("vault selection: scoped to another installation; ignored");
    return null;
  }
  return v;
}

/** Take persisted documents as this installation's, dropping foreign ones. */
export function adoptDocs(
  state: StoreState,
  docs: PersistedDocs,
  note: Note,
): void {
  for (const d of docs.diagnostics) note(d);
  state.selection = scopedSelection(state, docs.selection, note);
  if (docs.receipt && docs.receipt.installationId !== state.installationId) {
    note("receipt: scoped to another installation; ignored");
    state.receipt = null;
  } else {
    state.receipt = docs.receipt;
  }
  state.vaultSelection = scopedVaultSelection(state, docs, note);
  state.committedGeneration = docs.committedGeneration;
}

/** The current vault selection with `id` added to its disables. */
export function vaultSelectionWith(
  state: StoreState,
  instanceId: string,
  id: CapabilityId,
  now: string,
): VaultCapabilitySelection {
  const current = state.vaultSelection;
  const disabled = current?.disabled.includes(id)
    ? current.disabled
    : [...(current?.disabled ?? []), id].sort();
  return {
    schemaVersion: 1,
    kind: "VaultCapabilitySelection",
    instanceId,
    installationId: state.installationId,
    vaultId: state.vaultId ?? "no-vault",
    revision: `emergency-${now}`,
    disabled,
  };
}

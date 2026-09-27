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
  type ResolveInput,
  type RuntimeFacts,
  type VaultCapabilitySelection,
  diagnoseRuntimeDocuments,
} from "@opensesame/capability-composition";
import type { ParsedRuntimeConfig } from "../runtime-config.js";
import { collectRuntimeFacts, evaluatedModuleIds } from "./facts.js";
import { withoutPresetResidue } from "./preset-residue.js";
import type { PersistedDocs } from "./store-persist.js";
import { storeSeams } from "./store-seams.js";

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
    state.policy = withoutPresetResidue(section.instancePolicy);
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
  state.policy =
    docs.localPolicy.policy && withoutPresetResidue(docs.localPolicy.policy);
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
  // Vault files travel between devices, so a record another installation
  // wrote is that device's own disables: set it aside, as before.
  if (v.installationId !== state.installationId) {
    note("vault selection: scoped to another installation; ignored");
    return null;
  }
  // A record naming another vault, under this vault's own key, was lifted from
  // elsewhere. Dropping it would lift the restriction, and this scope may only
  // narrow: hand it to the resolver, which denies a foreign vault record.
  if (v.vaultId !== state.vaultId)
    note("vault selection: written for another vault; denies");
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
  // A foreign record already denies every optional capability; rewriting it
  // as this vault's own would narrow it to `disabled` and so widen.
  if (current && current.vaultId !== (state.vaultId ?? "no-vault"))
    return current;
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

/**
 * What the resolver cannot act on in the documents it was given — an id no
 * catalog entry matches, a core id in a policy, an unknown slot. The plan
 * simply leaves such an id out, so without these a typo in a policy or a
 * selection would vanish without a word (carried from #470: "unknown ids are
 * conflicts, never silently dropped").
 */
export function documentDiagnostics(input: ResolveInput): string[] {
  return diagnoseRuntimeDocuments(input).map((d) => `${d.path}: ${d.message}`);
}

/** Everything the resolver reads, taken from the store's state as it is now. */
export function resolveInputFor(
  state: StoreState,
  instanceId: string,
  installation: InstallationCapabilitySelection | null,
  receipt: ConsentReceipt | null,
): ResolveInput {
  if (!state.catalog || !state.distribution) {
    throw new Error("composition store has not booted");
  }
  return {
    catalog: state.catalog,
    distribution: state.distribution,
    instancePolicy: state.policy,
    provenance: state.provenance,
    policyValid: state.policyValid,
    workspace: storeSeams.workspaceRestriction(instanceId, state.vaultId),
    installation,
    vault: state.vaultSelection,
    receipt,
    facts: collectRuntimeFacts({
      evaluatedModuleIds: evaluatedModuleIds(),
      activeWorkerVariant: state.baseFacts?.activeWorkerVariant ?? null,
      now: storeSeams.now(),
    }),
    installationId: state.installationId,
    vaultId: state.vaultId,
  };
}

/**
 * The composition store, doubled, with the §4.1 shape — test support only.
 *
 * `fakePortsModule()` is what `vi.mock` returns for
 * `lib/configuration/capabilities-ports`: the same names production code
 * imports, backed by an in-memory store over the fixture catalog. Every
 * write is recorded so a suite can assert exactly what a surface committed —
 * and that Cancel committed nothing (CONSENT-02).
 */

import type {
  CapabilityCatalog,
  CapabilityId,
  CapabilityLifecycle,
  CapabilityState,
  CompositionChangeReview,
  ConsentReceipt,
  EffectivePlan,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  PolicyProvenance,
} from "@opensesame/capability-composition";
import type { ContributionKind } from "@opensesame/capability-composition";
import type { ContributionEntry } from "../../lib/capabilities/runtime-contract.js";
import type {
  CommitOutcome,
  CompositionSnapshot,
  EmergencyDisableOutcome,
} from "../../lib/capabilities/store-types.js";
import { FIXTURE_CATALOG, FIXTURE_IDS } from "./composition-fixture.js";
import {
  type DoubleInput,
  resolveDouble,
} from "./composition-resolve-double.js";

export type DoubleOptions = Partial<{
  policy: InstanceCapabilityPolicy | null;
  provenance: PolicyProvenance;
  selection: InstallationCapabilitySelection | null;
  receipt: ConsentReceipt | null;
  distributed: readonly CapabilityId[];
  unsupported: readonly CapabilityId[];
  evaluatedModuleIds: readonly string[];
  durability: CompositionSnapshot["durability"];
  vaultId: string | null;
  contributions: readonly Contribution[];
}>;

/** A registered contribution as the double holds it: its kind beside it. */
export type Contribution = Readonly<{
  kind: ContributionKind;
  entry: ContributionEntry<ContributionKind>;
}>;

export type CompositionDouble = {
  getSnapshot(): CompositionSnapshot;
  subscribe(listener: () => void): () => void;
  review(draft: InstallationCapabilitySelection): CompositionChangeReview;
  preview(draft: InstallationCapabilitySelection): EffectivePlan;
  commit(
    draft: InstallationCapabilitySelection,
    receipt: ConsentReceipt,
  ): Promise<CommitOutcome>;
  emergencyDisable(id: CapabilityId): Promise<EmergencyDisableOutcome>;
  invalidate(reason: string): void;
  onVaultChange(vaultId: string | null): void;
  /** Test handles. */
  commits: Array<{
    draft: InstallationCapabilitySelection;
    receipt: ConsentReceipt;
  }>;
  disabled: CapabilityId[];
  invalidations: string[];
  contributions: Contribution[];
  reset(options?: DoubleOptions): void;
  setActive(id: CapabilityId): void;
};

function lifecycleOf(
  state: CapabilityState,
  active: ReadonlySet<CapabilityId>,
): CapabilityLifecycle {
  if (!state.distributed) return "not-distributed";
  if (state.approved)
    return active.has(state.id) ? "active" : "approved-not-loaded";
  if (state.restartRequired) return "disabled-restart-required";
  if (state.reasons.includes("CONSENT_REQUIRED")) return "consent-required";
  if (state.reasons.includes("NOT_SELECTED")) return "not-selected";
  return "disabled";
}

export function createCompositionDouble(
  initial: DoubleOptions = {},
): CompositionDouble {
  let options: Required<DoubleOptions> = fill(initial);
  const listeners = new Set<() => void>();
  const active = new Set<CapabilityId>();
  let generation = 1;
  let snapshot: CompositionSnapshot;

  const inputFor = (
    selection: InstallationCapabilitySelection | null,
    receipt: ConsentReceipt | null,
    assumeConsent: boolean,
  ): DoubleInput => ({
    catalog: FIXTURE_CATALOG,
    policy: options.policy,
    provenance: options.provenance,
    distributed: new Set(options.distributed),
    unsupported: new Set(options.unsupported),
    selection,
    receipt,
    assumeConsent,
    evaluatedModuleIds: options.evaluatedModuleIds,
    installationId: "inst-1",
    vaultId: options.vaultId,
  });

  const publish = () => {
    const plan = resolveDouble(
      inputFor(options.selection, options.receipt, false),
    );
    const lifecycle: Record<CapabilityId, CapabilityLifecycle> = {};
    for (const state of Object.values(plan.capabilities))
      lifecycle[state.id] = lifecycleOf(state, active);
    snapshot = {
      status: "ready",
      plan,
      generation,
      provenance: options.provenance,
      policy: options.policy,
      selection: options.selection,
      receipt: options.receipt,
      lifecycle,
      durability: options.durability,
      diagnostics: [],
    };
    for (const listener of listeners) listener();
  };
  publish();

  const double: CompositionDouble = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    preview: (draft) => resolveDouble(inputFor(draft, options.receipt, true)),
    review(draft) {
      const before = snapshot.plan ?? double.preview(draft);
      const after = double.preview(draft);
      return reviewOf(before, after, FIXTURE_CATALOG);
    },
    async commit(draft, receipt) {
      double.commits.push({ draft, receipt });
      if (draft.basePolicyRevision !== (options.policy?.revision ?? "0")) {
        return { status: "conflict", reason: "policy-revision" };
      }
      generation += 1;
      options = { ...options, selection: draft, receipt };
      publish();
      return {
        status: "committed",
        generation,
        committedGeneration: generation,
      };
    },
    async emergencyDisable(id) {
      double.disabled.push(id);
      active.delete(id);
      const selection = options.selection;
      if (selection) {
        options = {
          ...options,
          selection: {
            ...selection,
            selectedOptional: selection.selectedOptional.filter(
              (item) => item !== id,
            ),
          },
        };
      }
      generation += 1;
      publish();
      return { blockedNow: true, durable: options.durability === "durable" };
    },
    invalidate(reason) {
      double.invalidations.push(reason);
      generation += 1;
      publish();
    },
    onVaultChange(vaultId) {
      options = { ...options, vaultId };
      generation += 1;
      publish();
    },
    commits: [],
    disabled: [],
    invalidations: [],
    contributions: [...options.contributions],
    reset(next = {}) {
      options = fill(next);
      double.commits.length = 0;
      double.disabled.length = 0;
      double.invalidations.length = 0;
      double.contributions.splice(
        0,
        double.contributions.length,
        ...options.contributions,
      );
      active.clear();
      generation = 1;
      publish();
    },
    setActive(id) {
      active.add(id);
      publish();
    },
  };
  return double;
}

function fill(options: DoubleOptions): Required<DoubleOptions> {
  return {
    policy: options.policy ?? null,
    provenance: options.provenance ?? "personal-local",
    selection: options.selection ?? null,
    receipt: options.receipt ?? null,
    distributed: options.distributed ?? FIXTURE_IDS,
    unsupported: options.unsupported ?? [],
    evaluatedModuleIds: options.evaluatedModuleIds ?? [],
    durability: options.durability ?? "durable",
    vaultId: options.vaultId ?? "personal",
    contributions: options.contributions ?? [],
  };
}

function reviewOf(
  before: EffectivePlan,
  after: EffectivePlan,
  catalog: CapabilityCatalog,
): CompositionChangeReview {
  const byId = new Map(catalog.capabilities.map((entry) => [entry.id, entry]));
  const was = new Set(before.approvedCapabilities);
  const now = new Set(after.approvedCapabilities);
  const enabled = after.approvedCapabilities.filter((id) => !was.has(id));
  const disabled = before.approvedCapabilities.filter((id) => !now.has(id));
  const wasModules = new Set(before.approvedModules);
  const nowModules = new Set(after.approvedModules);
  return {
    before: before.identity,
    after: after.identity,
    enabled,
    disabled,
    addedModules: after.approvedModules.filter((id) => !wasModules.has(id)),
    removedModules: before.approvedModules.filter((id) => !nowModules.has(id)),
    addedOperations: after.approvedOperations.filter(
      (id) => !before.approvedOperations.includes(id),
    ),
    removedOperations: before.approvedOperations.filter(
      (id) => !after.approvedOperations.includes(id),
    ),
    addedEgress: enabled.flatMap((id) => byId.get(id)?.egress ?? []),
    addedPermissions: [
      ...new Set(
        enabled.flatMap((id) => byId.get(id)?.browserPermissions ?? []),
      ),
    ],
    workerTransition:
      before.requiredWorkerVariant === after.requiredWorkerVariant
        ? null
        : {
            from: before.requiredWorkerVariant,
            to: after.requiredWorkerVariant,
          },
    requiresDocumentReload: enabled.filter(
      (id) => byId.get(id)?.requiresDocumentReload,
    ),
    requiresNewArtifact: false,
    restartRequiredFor: disabled.flatMap((id) => byId.get(id)?.moduleIds ?? []),
    conflicts: after.conflicts,
    consent: after.consent,
    widened: enabled.length > 0 && disabled.length > 0,
  };
}

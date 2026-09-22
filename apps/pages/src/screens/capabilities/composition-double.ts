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
  ContributionKind,
  EffectivePlan,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  PolicyProvenance,
} from "@opensesame/capability-composition";
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

/** Everything the double mutates, in one place so the factory stays small. */
type DoubleCore = {
  options: Required<DoubleOptions>;
  listeners: Set<() => void>;
  active: Set<CapabilityId>;
  generation: number;
  snapshot: CompositionSnapshot;
};
type CoreBase = Omit<DoubleCore, "snapshot">;

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

function inputFor(
  core: CoreBase,
  selection: InstallationCapabilitySelection | null,
  receipt: ConsentReceipt | null,
  assumeConsent: boolean,
): DoubleInput {
  const { options } = core;
  return {
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
  };
}

function snapshotOf(core: CoreBase): CompositionSnapshot {
  const { options } = core;
  const plan = resolveDouble(
    inputFor(core, options.selection, options.receipt, false),
  );
  const lifecycle: Record<CapabilityId, CapabilityLifecycle> = {};
  for (const state of Object.values(plan.capabilities))
    lifecycle[state.id] = lifecycleOf(state, core.active);
  return {
    status: "ready",
    plan,
    generation: core.generation,
    provenance: options.provenance,
    policy: options.policy,
    selection: options.selection,
    receipt: options.receipt,
    lifecycle,
    durability: options.durability,
    diagnostics: [],
  };
}

function publish(core: DoubleCore): void {
  core.snapshot = snapshotOf(core);
  for (const listener of core.listeners) listener();
}

function createCore(initial: DoubleOptions): DoubleCore {
  const base: CoreBase = {
    options: fill(initial),
    listeners: new Set(),
    active: new Set(),
    generation: 1,
  };
  return { ...base, snapshot: snapshotOf(base) };
}

async function commitOn(
  core: DoubleCore,
  draft: InstallationCapabilitySelection,
  receipt: ConsentReceipt,
): Promise<CommitOutcome> {
  if (draft.basePolicyRevision !== (core.options.policy?.revision ?? "0")) {
    return { status: "conflict", reason: "policy-revision" };
  }
  core.generation += 1;
  core.options = { ...core.options, selection: draft, receipt };
  publish(core);
  return {
    status: "committed",
    generation: core.generation,
    committedGeneration: core.generation,
  };
}

function withoutRoot(
  core: DoubleCore,
  id: CapabilityId,
): Required<DoubleOptions> {
  const selection = core.options.selection;
  if (!selection) return core.options;
  return {
    ...core.options,
    selection: {
      ...selection,
      selectedOptional: selection.selectedOptional.filter(
        (item) => item !== id,
      ),
    },
  };
}

export function createCompositionDouble(
  initial: DoubleOptions = {},
): CompositionDouble {
  const core = createCore(initial);
  const preview = (draft: InstallationCapabilitySelection) =>
    resolveDouble(inputFor(core, draft, core.options.receipt, true));
  /** Every mutation bumps the generation, exactly as the real store does. */
  const bump = () => {
    core.generation += 1;
    publish(core);
  };
  const double: CompositionDouble = {
    getSnapshot: () => core.snapshot,
    subscribe(listener) {
      core.listeners.add(listener);
      return () => core.listeners.delete(listener);
    },
    preview,
    review(draft) {
      const after = preview(draft);
      return reviewOf(core.snapshot.plan ?? after, after, FIXTURE_CATALOG);
    },
    commit(draft, receipt) {
      double.commits.push({ draft, receipt });
      return commitOn(core, draft, receipt);
    },
    async emergencyDisable(id) {
      double.disabled.push(id);
      core.active.delete(id);
      core.options = withoutRoot(core, id);
      bump();
      return {
        blockedNow: true,
        durable: core.options.durability === "durable",
      };
    },
    invalidate(reason) {
      double.invalidations.push(reason);
      bump();
    },
    onVaultChange(vaultId) {
      core.options = { ...core.options, vaultId };
      bump();
    },
    commits: [],
    disabled: [],
    invalidations: [],
    contributions: [...core.options.contributions],
    reset(next = {}) {
      core.options = fill(next);
      double.commits.length = 0;
      double.disabled.length = 0;
      double.invalidations.length = 0;
      double.contributions.splice(
        0,
        double.contributions.length,
        ...core.options.contributions,
      );
      core.active.clear();
      core.generation = 1;
      publish(core);
    },
    setActive(id) {
      core.active.add(id);
      publish(core);
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

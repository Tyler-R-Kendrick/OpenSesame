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
  ContributionEntry,
  ContributionKind,
  EffectivePlan,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  PolicyProvenance,
} from "@opensesame/capability-composition";
import { type BoundaryValue, isJsonObject, overlapCast } from "@opensesame/os-domain";
import { useSyncExternalStore } from "react";
import type { CommitOutcome, CompositionSnapshot, EmergencyDisableOutcome } from "../../lib/capabilities/store-types.js";
import type { CapabilityPreset, OutcomeView } from "../../lib/configuration/capabilities-ports.js";
import { type DoubleInput, resolveDouble } from "./composition-resolve-double.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_IDS,
  FIXTURE_PRESETS,
  fixturePresetToInstancePolicy,
} from "./composition-fixture.js";

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
  contributions: readonly ContributionEntry<ContributionKind>[];
}>;

export type CompositionDouble = {
  getSnapshot(): CompositionSnapshot;
  subscribe(listener: () => void): () => void;
  review(draft: InstallationCapabilitySelection): CompositionChangeReview;
  preview(draft: InstallationCapabilitySelection): EffectivePlan;
  commit(draft: InstallationCapabilitySelection, receipt: ConsentReceipt): Promise<CommitOutcome>;
  emergencyDisable(id: CapabilityId): Promise<EmergencyDisableOutcome>;
  invalidate(reason: string): void;
  onVaultChange(vaultId: string | null): void;
  /** Test handles. */
  commits: Array<{ draft: InstallationCapabilitySelection; receipt: ConsentReceipt }>;
  disabled: CapabilityId[];
  invalidations: string[];
  contributions: ContributionEntry<ContributionKind>[];
  reset(options?: DoubleOptions): void;
  setActive(id: CapabilityId): void;
};

function lifecycleOf(state: CapabilityState, active: ReadonlySet<CapabilityId>): CapabilityLifecycle {
  if (!state.distributed) return "not-distributed";
  if (state.approved) return active.has(state.id) ? "active" : "approved-not-loaded";
  if (state.restartRequired) return "disabled-restart-required";
  if (state.reasons.includes("CONSENT_REQUIRED")) return "consent-required";
  if (state.reasons.includes("NOT_SELECTED")) return "not-selected";
  return "disabled";
}

export function createCompositionDouble(initial: DoubleOptions = {}): CompositionDouble {
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
    const plan = resolveDouble(inputFor(options.selection, options.receipt, false));
    const lifecycle: Record<CapabilityId, CapabilityLifecycle> = {};
    for (const state of Object.values(plan.capabilities)) lifecycle[state.id] = lifecycleOf(state, active);
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
      return { status: "committed", generation, committedGeneration: generation };
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
            selectedOptional: selection.selectedOptional.filter((item) => item !== id),
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
      double.contributions.splice(0, double.contributions.length, ...options.contributions);
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
    addedOperations: after.approvedOperations.filter((id) => !before.approvedOperations.includes(id)),
    removedOperations: before.approvedOperations.filter((id) => !after.approvedOperations.includes(id)),
    addedEgress: enabled.flatMap((id) => byId.get(id)?.egress ?? []),
    addedPermissions: [...new Set(enabled.flatMap((id) => byId.get(id)?.browserPermissions ?? []))],
    workerTransition:
      before.requiredWorkerVariant === after.requiredWorkerVariant
        ? null
        : { from: before.requiredWorkerVariant, to: after.requiredWorkerVariant },
    requiresDocumentReload: enabled.filter((id) => byId.get(id)?.requiresDocumentReload),
    requiresNewArtifact: false,
    restartRequiredFor: disabled.flatMap((id) => byId.get(id)?.moduleIds ?? []),
    conflicts: after.conflicts,
    consent: after.consent,
    widened: enabled.length > 0 && disabled.length > 0,
  };
}

/** `buildConsentReceipt` over the fixture: roots plus every closure digest. */
export function fixtureConsentReceipt(
  plan: EffectivePlan,
  catalog: CapabilityCatalog,
  acceptedAt: string,
): ConsentReceipt {
  const exposure: Record<CapabilityId, string> = {};
  for (const entry of catalog.capabilities) {
    if (plan.approvedCapabilities.includes(entry.id)) exposure[entry.id] = entry.exposureDigest;
  }
  const roots = Object.values(plan.capabilities)
    .filter((state) => state.selected && state.tier === "optional" && state.approved)
    .map((state) => state.id)
    .sort();
  return {
    schemaVersion: 1,
    instanceId: plan.identity.instanceId,
    installationId: plan.identity.installationId,
    policyRevision: plan.identity.policyRevision,
    selectionRevision: plan.identity.selectionRevision,
    acceptedAt,
    roots,
    exposure,
    receiptDigest: `sha256:receipt-${roots.join(",")}`,
  };
}

const POLICY_FIELDS = new Set(["schemaVersion", "kind", "instanceId", "revision", "presetProvenance", "capabilities", "network", "updates"]);
const SELECTION_FIELDS = new Set(["schemaVersion", "kind", "instanceId", "installationId", "basePolicyRevision", "revision", "acceptedRequired", "selectedOptional", "chosenAlternatives", "delivery"]);
const VAULT_FIELDS = new Set(["schemaVersion", "kind", "instanceId", "installationId", "vaultId", "revision", "disabled"]);

function strictParse<T>(fields: ReadonlySet<string>, kind: string) {
  return (value: BoundaryValue) => {
    if (!isJsonObject(value)) {
      return { ok: false as const, diagnostics: [{ code: "type", message: "not a mapping", path: "" }] };
    }
    const unknown = Object.keys(value).find((key) => !fields.has(key));
    if (unknown) {
      return { ok: false as const, diagnostics: [{ code: "unknown_field", message: `unknown field ${unknown}`, path: unknown }] };
    }
    if (value.kind !== kind) {
      return { ok: false as const, diagnostics: [{ code: "kind", message: `kind must be ${kind}`, path: "kind" }] };
    }
    const parsed: T = overlapCast(value);
    return { ok: true as const, value: parsed };
  };
}

export function useContributionsDouble(double: CompositionDouble) {
  return <K extends ContributionKind>(kind: K): readonly ContributionEntry<K>[] => {
    useSyncExternalStore(double.subscribe, double.getSnapshot);
    const entries: ContributionEntry<K>[] = overlapCast(
      double.contributions.filter((entry) => entry.kind === kind),
    );
    return entries;
  };
}

/** The module `vi.mock` hands to every importer of the seam. */
export function fakePortsModule(double: CompositionDouble) {
  const useComposition = () => useSyncExternalStore(double.subscribe, double.getSnapshot);
  return {
    compositionStore: double,
    useComposition,
    useCapability: (id: CapabilityId) => useComposition().plan?.capabilities[id] ?? null,
    useContributions: useContributionsDouble(double),
    CAPABILITY_CATALOG: FIXTURE_CATALOG,
    PRESETS: FIXTURE_PRESETS,
    presetToInstancePolicy: fixturePresetToInstancePolicy,
    buildConsentReceipt: fixtureConsentReceipt,
    canonicalize: (value: BoundaryValue) => JSON.stringify(value),
    explainCapability: (plan: EffectivePlan, id: CapabilityId) => ({
      id,
      state: plan.capabilities[id],
      via: plan.capabilities[id]?.dependencyOf ?? [],
      conflicts: plan.conflicts.filter((conflict) => conflict.capability === id),
    }),
    parseInstancePolicy: strictParse<InstanceCapabilityPolicy>(POLICY_FIELDS, "InstanceCapabilityPolicy"),
    parseInstallationSelection: strictParse<InstallationCapabilitySelection>(SELECTION_FIELDS, "InstallationCapabilitySelection"),
    parseVaultSelection: strictParse(VAULT_FIELDS, "VaultCapabilitySelection"),
    previewPlan: (draft: InstallationCapabilitySelection) => double.preview(draft),
    PUBLICATION_CAPABILITIES: ["backup.git-remote"] as readonly CapabilityId[],
    viewOutcome: (outcome: BoundaryValue, durability = "unknown"): OutcomeView => {
      const record: { status?: string; reason?: string } = overlapCast(outcome ?? {});
      if (record.status === "committed") {
        return { status: durability === "session-only" ? "session-only" : "durable", message: "" };
      }
      if (record.status === "conflict") return { status: "conflict", message: record.reason ?? "" };
      return { status: "refused", message: record.reason ?? "" };
    },
  };
}

export type FakePorts = ReturnType<typeof fakePortsModule>;
export type { CapabilityPreset };

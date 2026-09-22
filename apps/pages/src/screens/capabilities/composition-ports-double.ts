/**
 * The seam module, doubled — what `vi.mock` returns for
 * `lib/configuration/capabilities-ports`. Test support only.
 */

import type {
  CapabilityCatalog,
  CapabilityId,
  ConsentReceipt,
  EffectivePlan,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
} from "@opensesame/capability-composition";
import { type BoundaryValue, isJsonObject, overlapCast } from "@opensesame/os-domain";
import { useSyncExternalStore } from "react";
import type {
  ContributionEntry,
  ContributionKind,
} from "../../lib/capabilities/runtime-contract.js";
import type { OutcomeView } from "../../lib/configuration/capabilities-ports.js";
import type { CompositionDouble } from "./composition-double.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_PRESETS,
  fixturePresetToInstancePolicy,
} from "./composition-fixture.js";

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
      double.contributions
        .filter((item) => item.kind === kind)
        .map((item) => item.entry),
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


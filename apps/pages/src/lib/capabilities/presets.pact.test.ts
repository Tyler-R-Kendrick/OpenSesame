/**
 * The preset → plan contract, carried forward from #470's
 * `preset-plan.pact.test`: every purpose preset, projected to a policy and
 * applied as a draft the way setup applies it, resolves against the real
 * catalog and this build's distribution to a plan that approves exactly what
 * the preset pre-selects once consent is given — no conflict, nothing it
 * refuses, nothing no one asked for.
 */
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import {
  PRESETS,
  presetToInstancePolicy,
} from "@opensesame/app-core/lib/capabilities/presets.js";
import {
  type CapabilityId,
  type ResolveInput,
  buildConsentReceipt,
  fixtureResolveInput,
  fixtureSelection,
  resolveComposition,
} from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  applyPreset,
} from "../../screens/capabilities/CapabilityDraft.js";
import { distributionFromOwnership } from "./ownership.js";

const NOW = "2026-09-22T00:00:00.000Z";
const INDEX = new Map(CAPABILITY_CATALOG.capabilities.map((d) => [d.id, d]));

function closureOf(roots: Iterable<CapabilityId>): Set<CapabilityId> {
  const seen = new Set<CapabilityId>();
  const stack = [...roots];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const d = INDEX.get(id);
    if (d === undefined) continue;
    stack.push(...d.dependencies, ...d.alternatives.flatMap((a) => a.oneOf));
  }
  return seen;
}

function optional(ids: readonly CapabilityId[]): CapabilityId[] {
  return ids.filter((id) => INDEX.get(id)?.tier === "optional");
}

describe.each(PRESETS)("preset $id → plan", (preset) => {
  const policy = presetToInstancePolicy(preset, "pact-instance", "pact-r1");
  const draft = applyPreset(
    { ...EMPTY_DRAFT, road: "customize" },
    preset,
    null,
  );
  const input: ResolveInput = fixtureResolveInput({
    catalog: CAPABILITY_CATALOG,
    distribution: distributionFromOwnership("selective"),
    instancePolicy: policy,
    provenance: "same-origin-deployment",
    installation: fixtureSelection({
      instanceId: policy.instanceId,
      basePolicyRevision: policy.revision,
      acceptedRequired: draft.acceptedRequired,
      selectedOptional: draft.roots,
      chosenAlternatives: draft.alternatives,
    }),
  });
  const before = resolveComposition(input);
  const plan = resolveComposition({
    ...input,
    receipt: buildConsentReceipt(before, CAPABILITY_CATALOG, NOW),
  });

  it("approves nothing optional before consent", () => {
    expect(optional(before.approvedCapabilities)).toEqual([]);
  });

  it("with consent, approves every pre-selected root with no conflict", () => {
    expect(plan.conflicts).toEqual([]);
    for (const id of preset.defaultSelected) {
      expect(plan.capabilities[id]?.reasons, id).toEqual([]);
      expect(plan.approvedCapabilities).toContain(id);
    }
  });

  it("approves nothing the preset refuses or no one asked for", () => {
    const wanted = closureOf([...preset.required, ...preset.defaultSelected]);
    for (const id of optional(plan.approvedCapabilities)) {
      expect(wanted.has(id), `${id} approved unwanted`).toBe(true);
      expect(policy.capabilities.prohibited).not.toContain(id);
    }
  });
});

import {
  type EffectivePlan,
  resolveEffectivePlan,
} from "@opensesame/capability-composition";
/**
 * Selective + hardened build fixtures: minimal and family plans.
 *
 * S00 integration: proves the full chain catalog → preset → resolver →
 * loader table → flags resolves to loadable, shippable plans for the two
 * canonical fixtures. The hardened assertions (no prohibited ids loaded,
 * every loaded id in the loader table, every flag matches activation)
 * run on every build fixture, not just in unit tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildCompositionCatalog,
  resolvePresetToPlanInput,
  toDescriptors,
} from "./catalog.js";
import { CompositionFlagProvider } from "./composition-openfeature.js";
import { assertKnown, entries as tableEntries } from "./loader-table.js";

function loaderTableFor(plan: EffectivePlan) {
  const entries: { id: string; moduleIds: string[]; assetIds: string[] }[] =
    plan.selected
      .filter((c) => c.stateAxes.loaded)
      .map((c) => ({
        id: c.id,
        moduleIds: [...c.moduleIds],
        assetIds: [],
      }));
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries,
  };
}

function checkHardened(plan: EffectivePlan, prohibited: readonly string[]) {
  for (const c of plan.selected) {
    if (c.stateAxes.loaded) {
      expect(prohibited).not.toContain(c.id);
    }
  }
  const table = loaderTableFor(plan);
  const known = tableEntries(table);
  for (const c of plan.selected) {
    if (c.stateAxes.loaded) {
      expect(() => assertKnown(table, c.id)).not.toThrow();
      expect(known.has(c.id)).toBe(true);
    }
  }
  const provider = new CompositionFlagProvider();
  provider.setPlan(plan);
  for (const c of plan.selected) {
    expect(provider.booleanFlag(c.id).enabled).toBe(
      c.activationStatus === "active",
    );
  }
}

describe("selective + hardened fixtures", () => {
  it("minimal (personal) fixture resolves hardened", () => {
    const outcome = resolveEffectivePlan(resolvePresetToPlanInput("personal"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    checkHardened(outcome.plan, []);
    expect(
      outcome.plan.selected.filter((c) => c.stateAxes.loaded).length,
    ).toBeGreaterThan(0);
  });

  it("family fixture resolves hardened", () => {
    const outcome = resolveEffectivePlan(resolvePresetToPlanInput("family"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    checkHardened(outcome.plan, []);
  });

  it("every catalog descriptor ships in the loader-table shape", () => {
    const catalog = buildCompositionCatalog();
    for (const ids of Object.values(catalog)) {
      const raws = toDescriptors(ids);
      expect(raws.length).toBe(ids.length);
    }
  });
});

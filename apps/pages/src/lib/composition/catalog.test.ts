import { validateDescriptor } from "@opensesame/capability-composition";
import { resolveEffectivePlan } from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import {
  SUGGESTION_KEYS,
  buildCompositionCatalog,
  registryEntry,
  resolvePresetToPlanInput,
  toDescriptors,
} from "./catalog.js";
import { ownerOf, unownedIds } from "./ownership.js";

describe("composition catalog", () => {
  it("every suggestion key resolves to at least one registry id", () => {
    const catalog = buildCompositionCatalog();
    for (const key of SUGGESTION_KEYS) {
      expect(catalog[key]?.length).toBeGreaterThan(0);
      for (const id of catalog[key] ?? []) {
        expect(registryEntry(id)).toBeDefined();
      }
    }
  });

  it("every emitted descriptor validates", () => {
    const catalog = buildCompositionCatalog();
    for (const ids of Object.values(catalog)) {
      for (const raw of toDescriptors(ids)) {
        expect(validateDescriptor(raw).ok).toBe(true);
      }
    }
  });

  it("unknown preset key fails closed", () => {
    expect(() => resolvePresetToPlanInput("personal", { nope: ["x"] })).toThrow(
      /missing catalog keys/,
    );
  });

  it("personal preset resolves to a loadable plan", () => {
    const outcome = resolveEffectivePlan(resolvePresetToPlanInput("personal"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      outcome.plan.selected.every((c) => c.activationStatus === "active"),
    ).toBe(true);
  });

  it("ownership covers every catalog id", () => {
    expect(unownedIds()).toEqual([]);
    expect(ownerOf("vault.items.search")).toMatch(/vault-team/);
    expect(ownerOf("nope.unknown")).toBeUndefined();
  });
});

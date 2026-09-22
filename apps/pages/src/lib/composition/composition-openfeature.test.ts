import { resolveEffectivePlan } from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import { resolvePresetToPlanInput } from "./catalog.js";
import {
  CompositionFlagProvider,
  enablesFlag,
} from "./composition-openfeature.js";

describe("composition flags", () => {
  it("defaults every flag to false with no plan", () => {
    const provider = new CompositionFlagProvider();
    expect(provider.booleanFlag("vault.items.search").enabled).toBe(false);
    expect(provider.booleanFlag("vault.items.search").reason).toBe("no-plan");
    expect(provider.allFlags()).toEqual([]);
  });

  it("enables only active capabilities", () => {
    const outcome = resolveEffectivePlan(resolvePresetToPlanInput("personal"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const provider = new CompositionFlagProvider();
    provider.setPlan(outcome.plan);
    expect(provider.booleanFlag("vault.items.search").enabled).toBe(true);
    expect(provider.booleanFlag("ghost.cap").enabled).toBe(false);
    expect(provider.allFlags().length).toBeGreaterThan(0);
  });

  it("enablesFlag is true only for active", () => {
    expect(enablesFlag("active")).toBe(true);
    for (const status of [
      "not-shipped",
      "not-selected",
      "not-loaded",
      "disabled",
      "cached",
      "restart-required",
    ] as const) {
      expect(enablesFlag(status)).toBe(false);
    }
  });
});

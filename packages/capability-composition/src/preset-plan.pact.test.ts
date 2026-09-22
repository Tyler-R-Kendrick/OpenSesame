import { describe, expect, it } from "vitest";
import { PRESETS, isPresetName, resolvePreset } from "./presets.js";
import { resolveEffectivePlan } from "./resolver.js";
import { descriptor, distribution, policy } from "./test-helpers.js";

const CATALOG = {
  "core.credentials.view": ["creds.view"],
  "core.fill.manual": ["fill.manual"],
  "core.share.household": ["share.household"],
  "core.share.organization": ["share.organization"],
  "core.egress.lan": ["egress.lan"],
  "core.audit.forward": ["audit.forward"],
} as const;

describe("preset → plan contract", () => {
  it("contract: every non-custom preset resolves against the catalog", () => {
    for (const name of [
      "personal",
      "family",
      "homelab",
      "organization",
    ] as const) {
      expect(isPresetName(name)).toBe(true);
      const resolved = resolvePreset(name, CATALOG);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.required.length).toBeGreaterThan(0);
      // Suggestions are catalog keys, never raw ids.
      for (const key of PRESETS[name].orderedSuggestions) {
        expect(key in CATALOG).toBe(true);
      }
    }
  });

  it("contract: the resolved required set loads when the distribution ships it", () => {
    const resolved = resolvePreset("family", CATALOG);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const ids = [...resolved.required, ...resolved.optional];
    const outcome = resolveEffectivePlan({
      distribution: distribution(ids.map((id) => descriptor(id))),
      instancePolicy: policy({
        required: [...resolved.required],
        optional: [...resolved.optional],
      }),
      runtimeEnvironments: ["document"],
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const id of resolved.required) {
      expect(
        outcome.plan.selected.find((c) => c.id === id)?.activationStatus,
      ).toBe("active");
    }
  });

  it("adversarial: a catalog missing a key fails closed, never defaults", () => {
    const resolved = resolvePreset("organization", {
      "core.credentials.view": ["creds.view"],
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.missing).toContain("core.share.organization");
    }
  });
});

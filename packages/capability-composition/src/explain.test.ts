import { describe, expect, it } from "vitest";
import { buildExplanation, explainReason } from "./explain.js";
import type { ModuleActivationLease } from "./lifecycle.js";
import { PRESETS, isPresetName, resolvePreset } from "./presets.js";

describe("explain", () => {
  it("explains every reason code", () => {
    expect(explainReason("NOT_DISTRIBUTED")).toMatch(/distribution/);
    expect(explainReason("PROHIBITED_BY_INSTANCE")).toMatch(/prohibit/i);
    expect(explainReason("UNKNOWN")).toBeTruthy();
  });
});

describe("presets", () => {
  it("carries exactly the five names", () => {
    expect(Object.keys(PRESETS).sort()).toEqual(
      ["custom", "family", "homelab", "organization", "personal"].sort(),
    );
    expect(isPresetName("personal")).toBe(true);
    expect(isPresetName("enterprise")).toBe(false);
  });

  it("resolves against a catalog to explicit ids", () => {
    const result = resolvePreset("personal", {
      "core.credentials.view": ["creds.view"],
      "core.fill.manual": ["fill.manual"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.required).toEqual(["creds.view"]);
      expect(result.optional).toEqual(["fill.manual"]);
    }
  });

  it("fails closed when the catalog is missing a suggestion key", () => {
    const result = resolvePreset("homelab", {
      "core.credentials.view": ["creds.view"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing.length).toBeGreaterThan(0);
  });

  it("custom preset has no suggestions — nothing can silently grow", () => {
    const result = resolvePreset("custom", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.required).toEqual([]);
      expect(result.optional).toEqual([]);
    }
  });
});

describe("lifecycle types (compile-shape only)", () => {
  it("lease shape carries plan-generation expiry", () => {
    const lease: ModuleActivationLease = {
      moduleId: "mod.a" as never,
      planDigest: "0".repeat(16),
      generation: 1,
      expiresAtKind: "plan-generation",
    };
    expect(lease.expiresAtKind).toBe("plan-generation");
  });
});

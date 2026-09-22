import { describe, expect, it } from "vitest";
import { buildExplanation, explainReason } from "./explain.js";
import { REASON_CODES } from "./ids.js";
import { moduleId } from "./ids.js";
import type { ModuleActivationLease } from "./lifecycle.js";
import { PRESETS, isPresetName, resolvePreset } from "./presets.js";

describe("explain", () => {
  it("explains every reason code", () => {
    expect(explainReason("NOT_DISTRIBUTED")).toMatch(/distribution/);
    expect(explainReason("PROHIBITED_BY_INSTANCE")).toMatch(/prohibit/i);
    expect(explainReason("UNKNOWN")).toBeTruthy();
  });

  it("covers the full closed reason-code union", () => {
    for (const code of REASON_CODES) {
      expect(explainReason(code)).toBeTruthy();
      expect(
        buildExplanation(
          {
            planIdentity: {
              instanceId: "inst-1",
              installationId: "install-1",
              vaultId: null,
              distributionId: "dist-1",
              policyRevision: 3,
              selectionRevision: 7,
              planDigest: "0".repeat(16),
            },
            evaluatedAt: "2026-01-01T00:00:00.000Z",
            selected: [
              {
                id: "a",
                descriptorVersion: 1,
                stateAxes: {
                  permitted: false,
                  selected: true,
                  availableInDistribution: true,
                  supportedByRuntime: true,
                  consented: true,
                  loaded: false,
                },
                reasonCodes: [code],
                conflicts: [
                  {
                    reasonCode: code,
                    capabilityId: "a",
                    detail: "char",
                    provenance: "char",
                  },
                ],
                activationStatus: "not-loaded",
                moduleIds: ["mod.a"],
              },
            ],
            conflicts: [
              {
                reasonCode: code,
                capabilityId: "a",
                detail: "char",
                provenance: "char",
              },
            ],
            consentDeltas: [],
          },
          "a",
        )?.explanations,
      ).toEqual([explainReason(code)]);
    }
  });

  it("returns undefined for a capability the plan never mentions", () => {
    expect(
      buildExplanation(
        {
          planIdentity: {
            instanceId: "inst-1",
            installationId: "install-1",
            vaultId: null,
            distributionId: "dist-1",
            policyRevision: 3,
            selectionRevision: 7,
            planDigest: "0".repeat(16),
          },
          evaluatedAt: "2026-01-01T00:00:00.000Z",
          selected: [],
          conflicts: [],
          consentDeltas: [],
        },
        "ghost",
      ),
    ).toBeUndefined();
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
    const module = moduleId("mod.a");
    if (module === undefined) throw new Error("fixture module id must parse");
    const lease: ModuleActivationLease = {
      moduleId: module,
      planDigest: "0".repeat(16),
      generation: 1,
      expiresAtKind: "plan-generation",
    };
    expect(lease.expiresAtKind).toBe("plan-generation");
  });
});

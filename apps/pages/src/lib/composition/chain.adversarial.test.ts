import { resolveEffectivePlan } from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import { resolvePresetToPlanInput } from "./catalog.js";

/**
 * S23 adversarial sign-off: the integrated chain under attack.
 *
 * Each case drives the FULL chain (catalog → preset → resolver → flags),
 * not an isolated module: a hostile catalog, a prohibited id smuggled into
 * required, a vault allow-list that admits nothing, and a selection bound
 * to a foreign vault. All must fail closed with no loaded capability.
 */
describe("S23 adversarial sign-off", () => {
  it("a hostile catalog (unknown suggestion key) fails closed", () => {
    expect(() =>
      resolvePresetToPlanInput("personal", {
        "core.credentials.view": ["vault.items.search"],
      }),
    ).toThrow(/missing catalog keys/);
  });

  it("prohibited ids smuggled into required never load", () => {
    const input = resolvePresetToPlanInput("personal");
    const hostile: typeof input = {
      ...input,
      instancePolicy: {
        schemaVersion: 1,
        kind: "instance-policy",
        instanceId: "catalog",
        revision: 1,
        required: ["vault.items.search", "legacy.plain"],
        optional: [],
        prohibited: ["legacy.plain"],
        network: { externalServices: "deny", allowedServiceOrigins: [] },
        updates: {
          unknownCapabilities: "deny",
          expandedExposure: "require-approval",
        },
      },
    };
    const outcome = resolveEffectivePlan(hostile);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const c of outcome.plan.selected) {
      expect(c.stateAxes.loaded && c.id === "legacy.plain").toBe(false);
    }
  });

  it("an allow-nothing vault loads nothing", () => {
    const input = resolvePresetToPlanInput("family");
    const outcome = resolveEffectivePlan({
      ...input,
      vaultRestriction: {
        schemaVersion: 1,
        kind: "vault-restriction",
        instanceId: "catalog",
        vaultId: "vault-1",
        basePolicyRevision: 1,
        revision: 1,
        allow: { ids: [] },
        optional: [],
        prohibited: [],
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.selected.every((c) => !c.stateAxes.loaded)).toBe(true);
  });

  it("a foreign-vault selection is rejected end to end", () => {
    const input = resolvePresetToPlanInput("family");
    const outcome = resolveEffectivePlan({
      ...input,
      vaultRestriction: {
        schemaVersion: 1,
        kind: "vault-restriction",
        instanceId: "catalog",
        vaultId: "vault-1",
        basePolicyRevision: 1,
        revision: 1,
        allow: "inherit",
        optional: [],
        prohibited: [],
      },
      installationSelection: {
        schemaVersion: 1,
        kind: "installation-selection",
        instanceId: "catalog",
        vaultId: "vault-2",
        vaultIdSource: "explicit",
        installationId: "install-1",
        revision: 7,
        required: [],
        optional: [],
        prohibited: [],
        allow: "inherit",
      },
    });
    expect(outcome.ok).toBe(false);
  });
});

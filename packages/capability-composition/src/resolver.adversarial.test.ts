import { describe, expect, it } from "vitest";
import { validateDescriptor } from "./descriptor.js";
import {
  validateInstallationSelection,
  validateInstancePolicy,
  validateVaultRestriction,
} from "./documents.js";
import { explainReason } from "./explain.js";
import { isReasonCode } from "./ids.js";
import { resolvePreset } from "./presets.js";
import { resolveEffectivePlan } from "./resolver.js";
import {
  descriptor,
  distribution,
  hostileFields,
  policy,
  selection,
  vaultRestriction,
} from "./test-helpers.js";

function base() {
  return {
    distribution: distribution([descriptor("a"), descriptor("b")]),
    instancePolicy: policy({ required: ["a"] }),
    runtimeEnvironments: ["document"] as const,
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("adversarial — confused deputy and fail-closed", () => {
  it("a vault allow-list cannot escalate past what the instance required", () => {
    const outcome = resolveEffectivePlan({
      ...base(),
      vaultRestriction: vaultRestriction({ allow: { ids: ["a", "b"] } }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // "b" is allowed by the vault but was never selected: absent from the plan.
    expect(outcome.plan.selected.some((c) => c.id === "b")).toBe(false);
  });

  it("a selection bound to another vault is rejected, not merged", () => {
    const outcome = resolveEffectivePlan({
      ...base(),
      vaultRestriction: vaultRestriction({ vaultId: "vault-1" }),
      installationSelection: selection({ vaultId: "vault-2" }),
    });
    expect(outcome.ok).toBe(false);
  });

  it("a selection bound to another instance is rejected, not merged", () => {
    const outcome = resolveEffectivePlan({
      ...base(),
      installationSelection: selection({ instanceId: "other" }),
    });
    expect(outcome.ok).toBe(false);
  });

  it("a self-dependency terminates with a cycle conflict", () => {
    const outcome = resolveEffectivePlan({
      distribution: distribution([descriptor("a", { dependencies: ["a"] })]),
      instancePolicy: policy({ required: ["a"] }),
      runtimeEnvironments: ["document"],
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.conflicts.some((c) => c.detail.includes("cycle"))).toBe(
      true,
    );
  });

  it("a three-node cycle terminates with a cycle conflict", () => {
    const outcome = resolveEffectivePlan({
      distribution: distribution([
        descriptor("a", { dependencies: ["b"] }),
        descriptor("b", { dependencies: ["c"] }),
        descriptor("c", { dependencies: ["a"] }),
      ]),
      instancePolicy: policy({ required: ["a"] }),
      runtimeEnvironments: ["document"],
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.conflicts.some((c) => c.detail.includes("cycle"))).toBe(
      true,
    );
  });

  it("consent cannot be smuggled through an unrelated id", () => {
    const outcome = resolveEffectivePlan({
      distribution: distribution([
        descriptor("priv", {
          declaredPrivileges: {
            egressOrigins: ["https://api.example.com"],
            keyAccess: {
              vaultRead: true,
              vaultWrite: false,
              deviceKeys: false,
            },
            browserPermissions: [],
          },
        }),
      ]),
      instancePolicy: policy({ required: ["priv"] }),
      runtimeEnvironments: ["document"],
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      consentedCapabilityIds: ["something-else"],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const entry = outcome.plan.selected.find((c) => c.id === "priv");
    expect(entry?.reasonCodes).toContain("CONSENT_REQUIRED");
    expect(entry?.stateAxes.loaded).toBe(false);
  });

  it("prototype pollution does not become a capability id", () => {
    // The boundary contract under test is attacker-shaped JSON; the hostile
    // fields type is the boundary parser's own output contract, and the
    // policy validator refuses the polluted shape at runtime.
    const polluted = hostileFields(
      '{"required":["__proto__"],"optional":[],"prohibited":[]}',
    );
    if (polluted === undefined) throw new Error("hostile JSON must parse");
    const outcome = resolveEffectivePlan({
      ...base(),
      instancePolicy: policy(polluted),
    });
    // Malformed ids fail closed at validation: no plan, no proto id anywhere.
    expect(outcome.ok).toBe(false);
  });

  it("every reason code in a hostile plan stays inside the closed union", () => {
    const outcome = resolveEffectivePlan({
      distribution: distribution([
        descriptor("a", { dependencies: ["ghost"] }),
        descriptor("b", { environments: ["service-worker"] }),
      ]),
      instancePolicy: policy({
        required: ["a", "b", "ghost.cap"],
        optional: ["also-ghost"],
        prohibited: ["b"],
      }),
      vaultRestriction: vaultRestriction({ allow: { ids: [] } }),
      runtimeEnvironments: ["document"],
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const codes = new Set<string>();
    for (const c of outcome.plan.selected) {
      for (const r of c.reasonCodes) codes.add(r);
    }
    for (const c of outcome.plan.conflicts) codes.add(c.reasonCode);
    for (const code of codes) {
      expect(isReasonCode(code)).toBe(true);
      if (!isReasonCode(code)) continue;
      expect(explainReason(code)).toBeTruthy();
    }
  });

  it("unknown document fields fail validation instead of widening authority", () => {
    expect(validateInstancePolicy(policy({ autoGrantAll: true })).ok).toBe(
      false,
    );
    expect(validateDescriptor(descriptor("a", { backdoor: true })).ok).toBe(
      false,
    );
    expect(validateVaultRestriction(vaultRestriction({ allow: {} })).ok).toBe(
      false,
    );
    expect(validateInstallationSelection(selection({ grant: "*" })).ok).toBe(
      false,
    );
  });

  it("a preset cannot smuggle ids: unknown names fail, not default", () => {
    expect(resolvePreset("personal", {}).ok).toBe(false);
  });
});

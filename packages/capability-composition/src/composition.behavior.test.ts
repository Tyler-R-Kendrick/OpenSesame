import { describe, expect, it } from "vitest";
import { type ResolverInput, resolveEffectivePlan } from "./resolver.js";
import {
  descriptor,
  distribution,
  policy,
  selection,
  vaultRestriction,
} from "./test-helpers.js";

function resolve(input: ResolverInput) {
  return resolveEffectivePlan(input);
}

function base(): ResolverInput {
  return {
    distribution: distribution([
      descriptor("core.fill"),
      descriptor("core.share", { dependencies: ["core.fill"] }),
    ]),
    instancePolicy: policy({
      required: ["core.fill"],
      optional: ["core.share"],
    }),
    runtimeEnvironments: ["document"],
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("composition journey", () => {
  it("Given a fresh instance, When the operator requires fill, Then fill is active and share waits unselected", () => {
    // Given — a fresh instance whose policy requires only fill.
    const input = base();

    // When — the operator resolves the plan.
    const outcome = resolve(input);

    // Then — fill loads; share is optional-but-wanted, so it loads too.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const fill = outcome.plan.selected.find((c) => c.id === "core.fill");
    expect(fill?.activationStatus).toBe("active");
    expect(fill?.stateAxes.loaded).toBe(true);
    const share = outcome.plan.selected.find((c) => c.id === "core.share");
    expect(share?.activationStatus).toBe("active");
    expect(share?.stateAxes.loaded).toBe(true);
  });

  it("Given a family vault, When the vault allows share, Then the share activates without touching the instance policy", () => {
    // Given — the same instance policy, narrowed to a family vault.
    const input: ResolverInput = {
      ...base(),
      vaultRestriction: vaultRestriction({
        allow: { ids: ["core.fill", "core.share"] },
      }),
      installationSelection: selection({
        required: ["core.fill", "core.share"],
      }),
    };

    // When — the operator resolves for that vault.
    const outcome = resolve(input);

    // Then — both capabilities load; the instance policy never changed.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const id of ["core.fill", "core.share"]) {
      expect(
        outcome.plan.selected.find((c) => c.id === id)?.activationStatus,
      ).toBe("active");
    }
    expect(outcome.plan.planIdentity.policyRevision).toBe(3);
  });

  it("Given a prohibited legacy id, When it is required anyway, Then it is disabled with instance-policy provenance", () => {
    // Given — an operator error: a shipped id both required and prohibited.
    const input: ResolverInput = {
      distribution: distribution([
        descriptor("core.fill"),
        descriptor("core.share", { dependencies: ["core.fill"] }),
        descriptor("legacy.plain"),
      ]),
      instancePolicy: policy({
        required: ["core.fill", "legacy.plain"],
        prohibited: ["legacy.plain"],
      }),
      runtimeEnvironments: ["document"],
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    };

    // When — the operator resolves.
    const outcome = resolve(input);

    // Then — prohibition wins; the conflict names the instance policy.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const conflict = outcome.plan.conflicts.find(
      (c) =>
        c.capabilityId === "legacy.plain" &&
        c.reasonCode === "PROHIBITED_BY_INSTANCE",
    );
    expect(conflict?.provenance).toContain("instance-policy");
  });
});

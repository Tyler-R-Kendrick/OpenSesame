import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import type { ExecutionEnvironment } from "./descriptor.js";
import type { DistributionInventory, ResolverInput } from "./resolver.js";
import { resolveEffectivePlan } from "./resolver.js";
import {
  descriptor,
  distribution,
  makePrng,
  policy,
  selection,
  shuffled,
  vaultRestriction,
} from "./test-helpers.js";

function planFor(overrides: {
  descriptors?: BoundaryValue[];
  policy?: Record<string, BoundaryValue>;
  vault?: Record<string, BoundaryValue>;
  selection?: Record<string, BoundaryValue>;
  distribution?: Partial<DistributionInventory>;
  runtime?: ExecutionEnvironment[];
  consented?: string[];
}): ReturnType<typeof resolveEffectivePlan> {
  const descriptors = overrides.descriptors ?? [];
  const built = distribution(descriptors);
  const input: ResolverInput = {
    ...(overrides.distribution
      ? { distribution: { ...built, ...overrides.distribution } }
      : { distribution: built }),
    instancePolicy: policy(overrides.policy ?? {}),
    ...(overrides.vault
      ? { vaultRestriction: vaultRestriction(overrides.vault) }
      : {}),
    ...(overrides.selection
      ? { installationSelection: selection(overrides.selection) }
      : {}),
    runtimeEnvironments: overrides.runtime ?? ["document"],
    evaluatedAt: "2026-01-01T00:00:00.000Z",
    ...(overrides.consented
      ? { consentedCapabilityIds: overrides.consented }
      : {}),
  };
  return resolveEffectivePlan(input);
}

function statusOf(
  outcome: ReturnType<typeof resolveEffectivePlan>,
  id: string,
): string | undefined {
  if (!outcome.ok) return undefined;
  return outcome.plan.selected.find((c) => c.id === id)?.activationStatus;
}

function reasonsOf(
  outcome: ReturnType<typeof resolveEffectivePlan>,
  id: string,
): readonly string[] {
  if (!outcome.ok) return [];
  return outcome.plan.selected.find((c) => c.id === id)?.reasonCodes ?? [];
}

describe("model contract", () => {
  it("no selection => minimal plan with nothing loaded", () => {
    const outcome = planFor({
      descriptors: [descriptor("a"), descriptor("b")],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.selected.every((c) => !c.stateAxes.loaded)).toBe(true);
    expect(
      outcome.plan.selected.every((c) => c.activationStatus === "not-selected"),
    ).toBe(true);
    expect(outcome.plan.conflicts).toEqual([]);
  });

  it("required capability loads and is active", () => {
    const outcome = planFor({
      descriptors: [descriptor("a")],
      policy: { required: ["a"] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusOf(outcome, "a")).toBe("active");
    expect(outcome.plan.selected.find((c) => c.id === "a")?.stateAxes).toEqual({
      permitted: true,
      selected: true,
      availableInDistribution: true,
      supportedByRuntime: true,
      consented: true,
      loaded: true,
    });
  });

  it("conflicting id in required+optional+prohibited => validation-style failure with provenance", () => {
    const outcome = planFor({
      descriptors: [descriptor("a")],
      policy: { required: ["a"], optional: ["a"], prohibited: ["a"] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const conflict = outcome.plan.conflicts.find(
      (c) =>
        c.capabilityId === "a" && c.reasonCode === "PROHIBITED_BY_INSTANCE",
    );
    expect(conflict).toBeDefined();
    expect(conflict?.provenance).toContain("instance-policy");
    expect(statusOf(outcome, "a")).toBe("disabled");
  });

  it("prohibition in any document wins over selection", () => {
    const outcome = planFor({
      descriptors: [descriptor("a")],
      policy: { required: ["a"] },
      selection: { required: ["a"], prohibited: ["a"] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusOf(outcome, "a")).toBe("disabled");
  });
});

describe("inherit vs explicit allow sets", () => {
  it("inherit keeps everything permitted; explicit empty set denies by workspace", () => {
    const inherit = planFor({
      descriptors: [descriptor("a")],
      policy: { required: ["a"] },
      vault: { allow: "inherit" },
    });
    expect(statusOf(inherit, "a")).toBe("active");

    const allowNone = planFor({
      descriptors: [descriptor("a")],
      policy: { required: ["a"] },
      vault: { allow: { ids: [] } },
    });
    expect(statusOf(allowNone, "a")).toBe("not-loaded");
    expect(reasonsOf(allowNone, "a")).toContain("DENIED_BY_WORKSPACE");
  });

  it("explicit allow list admits only members", () => {
    const outcome = planFor({
      descriptors: [descriptor("a"), descriptor("b")],
      policy: { required: ["a", "b"] },
      vault: { allow: { ids: ["a"] } },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusOf(outcome, "a")).toBe("active");
    expect(reasonsOf(outcome, "b")).toContain("DENIED_BY_WORKSPACE");
  });
});

describe("dependencies", () => {
  it("selected capability with prohibited dependency => conflict, nothing loaded", () => {
    const outcome = planFor({
      descriptors: [
        descriptor("a", { dependencies: ["dep"] }),
        descriptor("dep"),
      ],
      policy: { required: ["a"], prohibited: ["dep"] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusOf(outcome, "a")).toBe("not-loaded");
    expect(statusOf(outcome, "dep")).toBe("disabled");
    expect(reasonsOf(outcome, "a")).toContain("DEPENDENCY_CONFLICT");
  });

  it("missing dependency is surfaced, never auto-enabled", () => {
    const outcome = planFor({
      descriptors: [descriptor("a", { dependencies: ["ghost"] })],
      policy: { required: ["a"] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusOf(outcome, "a")).toBe("not-loaded");
    expect(
      outcome.plan.conflicts.some(
        (c) =>
          c.reasonCode === "DEPENDENCY_CONFLICT" && c.detail.includes("ghost"),
      ),
    ).toBe(true);
  });

  it("dependency cycle => conflict, not hang", () => {
    const outcome = planFor({
      descriptors: [
        descriptor("a", { dependencies: ["b"] }),
        descriptor("b", { dependencies: ["a"] }),
      ],
      policy: { required: ["a"] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.conflicts.some((c) => c.detail.includes("cycle"))).toBe(
      true,
    );
  });
});

describe("unknown ids", () => {
  it("unknown required id => NOT_DISTRIBUTED conflict with diagnostic", () => {
    const outcome = planFor({
      descriptors: [descriptor("a")],
      policy: { required: ["ghost.cap"] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const conflict = outcome.plan.conflicts.find(
      (c) => c.capabilityId === "ghost.cap",
    );
    expect(conflict?.reasonCode).toBe("NOT_DISTRIBUTED");
    expect(conflict?.detail).toBeTruthy();
  });

  it("optional unknown id is also surfaced", () => {
    const outcome = planFor({
      descriptors: [descriptor("a")],
      policy: { optional: ["ghost.cap"] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      outcome.plan.conflicts.some((c) => c.capabilityId === "ghost.cap"),
    ).toBe(true);
  });
});

describe("consent and runtime axes", () => {
  it("privilege-carrying capability requires consent; consent clears it", () => {
    const privileged = descriptor("e", {
      declaredPrivileges: {
        egressOrigins: ["https://api.example.com"],
        keyAccess: { vaultRead: false, vaultWrite: false, deviceKeys: false },
        browserPermissions: [],
      },
    });
    const noConsent = planFor({
      descriptors: [privileged],
      policy: { required: ["e"] },
    });
    expect(reasonsOf(noConsent, "e")).toContain("CONSENT_REQUIRED");

    const consented = planFor({
      descriptors: [privileged],
      policy: { required: ["e"] },
      consented: ["e"],
    });
    expect(statusOf(consented, "e")).toBe("active");
  });

  it("unsupported runtime blocks loading", () => {
    const outcome = planFor({
      descriptors: [descriptor("w", { environments: ["service-worker"] })],
      policy: { required: ["w"] },
      runtime: ["document"],
    });
    expect(reasonsOf(outcome, "w")).toContain("UNSUPPORTED_RUNTIME");
  });

  it("missing modules make the capability not-shipped", () => {
    const outcome = planFor({
      descriptors: [descriptor("a")],
      policy: { required: ["a"] },
      distribution: { moduleIds: [] },
    });
    expect(statusOf(outcome, "a")).toBe("not-shipped");
    expect(reasonsOf(outcome, "a")).toContain("NOT_DISTRIBUTED");
  });

  it("requiresDocumentReload yields restart-required", () => {
    const outcome = planFor({
      descriptors: [descriptor("r", { requiresDocumentReload: true })],
      policy: { required: ["r"] },
    });
    expect(statusOf(outcome, "r")).toBe("restart-required");
  });

  it("invalid documents fail resolution with provenance", () => {
    const outcome = planFor({
      descriptors: [descriptor("a")],
      policy: { schemaVersion: 9 },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failures.some((f) => f.field === "schemaVersion")).toBe(
      true,
    );
  });

  it("vault bound to a different instance is rejected", () => {
    const outcome = planFor({
      descriptors: [descriptor("a")],
      vault: { instanceId: "other" },
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("property: monotonicity", () => {
  it("narrowing the permitted set never enlarges the loadable set (50 cases)", () => {
    const prng = makePrng(0x5eed);
    for (let i = 0; i < 50; i += 1) {
      const ids = ["a", "b", "c", "d", "e"];
      const descriptors = ids.map((id) =>
        descriptor(id, {
          dependencies:
            prng() < 0.4 ? [ids[Math.floor(prng() * ids.length)] ?? id] : [],
        }),
      );
      const required = shuffled(ids, prng).slice(0, 1 + Math.floor(prng() * 3));
      const prohibited = shuffled(ids, prng).slice(0, Math.floor(prng() * 2));
      const vaultIds = shuffled(ids, prng).slice(0, Math.floor(prng() * 4));
      const wide = planFor({
        descriptors,
        policy: { required, prohibited },
        vault: { allow: "inherit" },
      });
      const narrow = planFor({
        descriptors,
        policy: { required, prohibited },
        vault: { allow: { ids: vaultIds } },
      });
      expect(wide.ok).toBe(true);
      expect(narrow.ok).toBe(true);
      if (!wide.ok || !narrow.ok) return;
      const loadedWide = new Set(
        wide.plan.selected.filter((c) => c.stateAxes.loaded).map((c) => c.id),
      );
      const loadedNarrow = new Set(
        narrow.plan.selected.filter((c) => c.stateAxes.loaded).map((c) => c.id),
      );
      for (const id of loadedNarrow) {
        expect(loadedWide.has(id)).toBe(true);
      }
    }
  });
});

describe("property: order independence", () => {
  it("any input ordering yields the same planDigest (50 cases)", () => {
    const prng = makePrng(0xd1ce);
    for (let i = 0; i < 50; i += 1) {
      const ids = ["a", "b", "c", "d", "e", "f"];
      const descriptors = ids.map((id) => descriptor(id));
      const required = shuffled(ids, prng).slice(0, 2);
      const optional = shuffled(ids, prng).slice(2, 4);
      const prohibited = shuffled(ids, prng).slice(5);
      const base = planFor({
        descriptors,
        policy: { required, optional, prohibited },
      });
      const permuted = planFor({
        descriptors: shuffled(descriptors, prng),
        policy: {
          required: shuffled(required, prng),
          optional: shuffled(optional, prng),
          prohibited: shuffled(prohibited, prng),
        },
      });
      expect(base.ok).toBe(true);
      expect(permuted.ok).toBe(true);
      if (!base.ok || !permuted.ok) return;
      expect(permuted.plan.planIdentity.planDigest).toBe(
        base.plan.planIdentity.planDigest,
      );
    }
  });
});

describe("digest stability of plans", () => {
  it("same inputs twice => same digest; changed input => different digest", () => {
    const args = {
      descriptors: [descriptor("a"), descriptor("b")],
      policy: { required: ["a"] },
    };
    const first = planFor(args);
    const second = planFor(args);
    const changed = planFor({ ...args, policy: { required: ["a", "b"] } });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.plan.planIdentity.planDigest).toBe(
      first.plan.planIdentity.planDigest,
    );
    if (changed.ok) {
      expect(changed.plan.planIdentity.planDigest).not.toBe(
        first.plan.planIdentity.planDigest,
      );
    }
  });
});

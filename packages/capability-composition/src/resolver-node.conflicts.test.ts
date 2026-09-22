import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { validateDescriptor } from "./descriptor.js";
import { evaluateNode } from "./resolver-node.js";
import { descriptor } from "./test-helpers.js";

function mustDescriptor(
  id: string,
  overrides?: Record<string, BoundaryValue>,
): Parameters<typeof evaluateNode>[1] {
  const checked = validateDescriptor(
    descriptor(id, overrides ?? {}),
  );
  if (!checked.ok) throw new Error(`fixture descriptor ${id} must validate`);
  return checked.descriptor;
}

describe("node evaluation detail — conflict objects", () => {
  it("pins prohibited and not-shipped conflict objects exactly", () => {
    const prohibited = evaluateNode("a", mustDescriptor("a"), 1, {
      wanted: new Set(["a"]),
      optionalWanted: new Set(),
      blockedByDeps: [],
      prohibitedBy: new Set(["instance-policy"]),
      ceiling: {
        ids: new Map(),
        explicit: false,
        provenance: "instance-policy",
      },
      shipped: new Set(["a"]),
      shippedModules: new Set(["mod.a"]),
      runtime: new Set(["document"]),
      consented: new Set(),
      cached: new Set(),
    });
    expect(prohibited.entry.reasonCodes).toEqual(["PROHIBITED_BY_INSTANCE"]);
    expect(prohibited.conflicts).toHaveLength(1);
    expect(prohibited.conflicts[0]).toMatchObject({
      reasonCode: "PROHIBITED_BY_INSTANCE",
      capabilityId: "a",
      detail: "prohibited by instance-policy",
      provenance: "instance-policy",
    });
    const unshipped = evaluateNode("a", mustDescriptor("a"), 1, {
      wanted: new Set(["a"]),
      optionalWanted: new Set(),
      blockedByDeps: [],
      prohibitedBy: new Set(),
      ceiling: {
        ids: new Map(),
        explicit: false,
        provenance: "instance-policy",
      },
      shipped: new Set(),
      shippedModules: new Set(["mod.a"]),
      runtime: new Set(["document"]),
      consented: new Set(),
      cached: new Set(),
    });
    expect(unshipped.entry.reasonCodes).toEqual(["NOT_DISTRIBUTED"]);
    expect(unshipped.conflicts).toHaveLength(1);
    expect(unshipped.conflicts[0]).toMatchObject({
      reasonCode: "NOT_DISTRIBUTED",
      capabilityId: "a",
      detail: "not shipped (or its modules are not) in this build",
      provenance: "distribution",
    });
  });

  it("pins runtime and consent conflict objects exactly", () => {
    const runtime = evaluateNode(
      "w",
      mustDescriptor("w", { environments: ["service-worker"] }),
      1,
      {
        wanted: new Set(["w"]),
        optionalWanted: new Set(),
        blockedByDeps: [],
        prohibitedBy: new Set(),
        ceiling: {
          ids: new Map(),
          explicit: false,
          provenance: "instance-policy",
        },
        shipped: new Set(["w"]),
        shippedModules: new Set(["mod.w"]),
        runtime: new Set(["document"]),
        consented: new Set(),
        cached: new Set(),
      },
    );
    expect(runtime.entry.reasonCodes).toEqual(["UNSUPPORTED_RUNTIME"]);
    expect(runtime.conflicts).toHaveLength(1);
    expect(runtime.conflicts[0]).toMatchObject({
      reasonCode: "UNSUPPORTED_RUNTIME",
      capabilityId: "w",
      detail: "needs one of service-worker",
      provenance: "runtime",
    });
    const consent = evaluateNode("a", mustDescriptor("a"), 1, {
      wanted: new Set(["a"]),
      optionalWanted: new Set(),
      blockedByDeps: [],
      prohibitedBy: new Set(),
      ceiling: {
        ids: new Map(),
        explicit: false,
        provenance: "instance-policy",
      },
      shipped: new Set(["a"]),
      shippedModules: new Set(["mod.a"]),
      runtime: new Set(["document"]),
      consented: new Set(),
      cached: new Set(),
    });
    expect(consent.entry.reasonCodes).toEqual([]);
    expect(consent.entry.activationStatus).toBe("active");
  });

  it("pins the permitted axis false for prohibited members", () => {
    const evaluation = evaluateNode("a", mustDescriptor("a"), 1, {
      wanted: new Set(["a"]),
      optionalWanted: new Set(),
      blockedByDeps: [],
      prohibitedBy: new Set(["instance-policy"]),
      ceiling: {
        ids: new Map(),
        explicit: false,
        provenance: "instance-policy",
      },
      shipped: new Set(["a"]),
      shippedModules: new Set(["mod.a"]),
      runtime: new Set(["document"]),
      consented: new Set(),
      cached: new Set(),
    });
    expect(evaluation.entry.stateAxes.permitted).toBe(false);
    expect(evaluation.entry.stateAxes.loaded).toBe(false);
    expect(evaluation.entry.activationStatus).toBe("disabled");
  });

  it("joins several missing environments with a comma and space", () => {
    const evaluation = evaluateNode(
      "w",
      mustDescriptor("w", {
        environments: ["dedicated-worker", "service-worker"],
      }),
      1,
      {
        wanted: new Set(["w"]),
        optionalWanted: new Set(),
        blockedByDeps: [],
        prohibitedBy: new Set(),
        ceiling: {
          ids: new Map(),
          explicit: false,
          provenance: "instance-policy",
        },
        shipped: new Set(["w"]),
        shippedModules: new Set(["mod.w"]),
        runtime: new Set(["document"]),
        consented: new Set(),
        cached: new Set(),
      },
    );
    expect(evaluation.conflicts[0]).toMatchObject({
      reasonCode: "UNSUPPORTED_RUNTIME",
      detail: "needs one of dedicated-worker, service-worker",
    });
  });

  it("pins the consent-required conflict object exactly", () => {
    const evaluation = evaluateNode(
      "priv",
      mustDescriptor("priv", {
        declaredPrivileges: {
          egressOrigins: ["https://api.example.com"],
          keyAccess: { vaultRead: false, vaultWrite: false, deviceKeys: false },
          browserPermissions: [],
        },
      }),
      1,
      {
        wanted: new Set(["priv"]),
        optionalWanted: new Set(),
        blockedByDeps: [],
        prohibitedBy: new Set(),
        ceiling: {
          ids: new Map(),
          explicit: false,
          provenance: "instance-policy",
        },
        shipped: new Set(["priv"]),
        shippedModules: new Set(["mod.priv"]),
        runtime: new Set(["document"]),
        consented: new Set(),
        cached: new Set(),
      },
    );
    expect(evaluation.entry.reasonCodes).toEqual(["CONSENT_REQUIRED"]);
    expect(evaluation.entry.stateAxes.consented).toBe(false);
    expect(evaluation.entry.stateAxes.loaded).toBe(false);
    expect(evaluation.conflicts).toHaveLength(1);
    expect(evaluation.conflicts[0]).toMatchObject({
      reasonCode: "CONSENT_REQUIRED",
      capabilityId: "priv",
      detail: "declared privileges require consent",
      provenance: "declaredPrivileges",
    });
    expect(evaluation.delta).toEqual({
      capabilityId: "priv",
      required: true,
      granted: false,
    });
  });

  it("names the missing runtime environments in the conflict", () => {
    const evaluation = evaluateNode(
      "w",
      mustDescriptor("w", { environments: ["service-worker"] }),
      1,
      {
        wanted: new Set(["w"]),
        optionalWanted: new Set(),
        blockedByDeps: [],
        prohibitedBy: new Set(),
        ceiling: {
          ids: new Map(),
          explicit: false,
          provenance: "instance-policy",
        },
        shipped: new Set(["w"]),
        shippedModules: new Set(["mod.w"]),
        runtime: new Set(["document"]),
        consented: new Set(),
        cached: new Set(),
      },
    );
    expect(evaluation.conflicts[0]?.detail).toBe("needs one of service-worker");
  });
});

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

describe("node evaluation detail", () => {
  it("sorts blocked deps before rendering the conflict detail", () => {
    const evaluation = evaluateNode("a", mustDescriptor("a"), 1, {
      wanted: new Set(["a"]),
      optionalWanted: new Set(),
      blockedByDeps: ["z-dep", "a-dep"],
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
    expect(evaluation.conflicts[0]?.detail).toBe(
      "depends on blocked a-dep, z-dep",
    );
  });

  it("renders every prohibited source in the detail and provenance", () => {
    const evaluation = evaluateNode("a", mustDescriptor("a"), 1, {
      wanted: new Set(["a"]),
      optionalWanted: new Set(),
      blockedByDeps: [],
      prohibitedBy: new Set(["vault-restriction", "instance-policy"]),
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
    expect(evaluation.conflicts[0]?.detail).toBe(
      "prohibited by instance-policy, vault-restriction",
    );
    expect(evaluation.conflicts[0]?.provenance).toBe(
      "instance-policy,vault-restriction",
    );
  });

  it("treats a dependency-only member as selected but not wanted", () => {
    const evaluation = evaluateNode("dep", mustDescriptor("dep"), 2, {
      wanted: new Set(["a"]),
      optionalWanted: new Set(),
      blockedByDeps: [],
      prohibitedBy: new Set(),
      ceiling: {
        ids: new Map(),
        explicit: false,
        provenance: "instance-policy",
      },
      shipped: new Set(["dep"]),
      shippedModules: new Set(["mod.dep"]),
      runtime: new Set(["document"]),
      consented: new Set(),
      cached: new Set(),
    });
    // Selected via dependents, but activation still reports not-selected
    // because "wanted" (required/optional) never named it.
    expect(evaluation.entry.stateAxes.selected).toBe(true);
    expect(evaluation.entry.activationStatus).toBe("not-selected");
  });

  it("reports a cached load as cached, and a reload load as restart-required", () => {
    const cached = evaluateNode("a", mustDescriptor("a"), 1, {
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
      cached: new Set(["a"]),
    });
    expect(cached.entry.activationStatus).toBe("cached");
    const reload = evaluateNode(
      "a",
      mustDescriptor("a", { requiresDocumentReload: true }),
      0,
      {
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
      },
    );
    expect(reload.entry.activationStatus).toBe("restart-required");
  });

  it("pins every reason-code literal against the closed union", () => {
    const evaluation = evaluateNode("a", mustDescriptor("a"), 1, {
      wanted: new Set(["a"]),
      optionalWanted: new Set(),
      blockedByDeps: ["dep"],
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
    expect(evaluation.entry.reasonCodes).toEqual(["DEPENDENCY_CONFLICT"]);
    expect(evaluation.conflicts).toHaveLength(1);
    expect(evaluation.conflicts[0]).toMatchObject({
      reasonCode: "DEPENDENCY_CONFLICT",
      capabilityId: "a",
      detail: "depends on blocked dep",
      provenance: "dependency-closure",
    });
  });

  it("distinguishes wanted, optional, and dependency-only selection", () => {
    const context = {
      optionalWanted: new Set<string>(),
      blockedByDeps: new Array<string>(),
      prohibitedBy: new Set<string>(),
      ceiling: {
        ids: new Map<string, "allow">(),
        explicit: false,
        provenance: "instance-policy",
      },
      shipped: new Set(["a"]),
      shippedModules: new Set(["mod.a"]),
      runtime: new Set(["document"] as const),
      consented: new Set<string>(),
      cached: new Set<string>(),
    };
    const wanted = evaluateNode("a", mustDescriptor("a"), 0, {
      ...context,
      wanted: new Set(["a"]),
    });
    expect(wanted.entry.stateAxes.selected).toBe(true);
    const optional = evaluateNode("a", mustDescriptor("a"), 0, {
      ...context,
      wanted: new Set<string>(),
      optionalWanted: new Set(["a"]),
    });
    expect(optional.entry.stateAxes.selected).toBe(true);
    const neither = evaluateNode("a", mustDescriptor("a"), 0, {
      ...context,
      wanted: new Set<string>(),
    });
    expect(neither.entry.stateAxes.selected).toBe(false);
    expect(neither.entry.activationStatus).toBe("not-selected");
  });
});

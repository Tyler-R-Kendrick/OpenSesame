/**
 * computeClosure pinned exactly — conflict codes, subjects, messages, the
 * dependents map, slot order and termination — carried forward from #470's
 * resolver-node conflict/detail suites, which pinned every conflict object so
 * its mutation slice could reach 100. Axes are built by hand so each case
 * states one fact.
 */
import { describe, expect, it } from "vitest";
import type { Axis } from "./resolve-axes.js";
import { computeClosure } from "./resolve-closure.js";
import type {
  CapabilityDescriptor,
  CapabilityId,
  InstallationCapabilitySelection,
  ReasonCode,
} from "./types.js";

function descriptor(
  id: CapabilityId,
  over: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor {
  return {
    id,
    descriptorVersion: 1,
    tier: "optional",
    title: id,
    summary: "",
    dependencies: [],
    alternatives: [],
    operationIds: [],
    moduleIds: [`${id}/runtime`],
    environments: ["document"],
    egress: [],
    browserPermissions: [],
    keyAccess: "none",
    requiresService: false,
    offlineLimits: "",
    workerGraphConstraint: null,
    requiresDocumentReload: false,
    itemKinds: [],
    exposureDigest: `sha256:${"0".repeat(64)}`,
    ...over,
  };
}

function axis(
  id: CapabilityId,
  blocked: readonly ReasonCode[] = [],
  tier: "core" | "optional" = "optional",
): Axis {
  return {
    id,
    tier,
    distributed: true,
    permitted: blocked.length === 0,
    required: false,
    selected: false,
    runtimeSupported: true,
    blocked,
  };
}

function closure(
  descriptors: readonly CapabilityDescriptor[],
  axes: readonly Axis[],
  roots: readonly CapabilityId[],
  chosen: InstallationCapabilitySelection["chosenAlternatives"] = {},
) {
  return computeClosure(
    new Map(descriptors.map((d) => [d.id, d])),
    new Map(axes.map((a) => [a.id, a])),
    roots,
    chosen,
  );
}

describe("a blocked dependency: the conflict code, subject and message", () => {
  it.each([
    [["NOT_DISTRIBUTED"], "DEPENDENCY_NOT_DISTRIBUTED"],
    [["PROHIBITED_BY_INSTANCE"], "DEPENDENCY_PROHIBITED"],
    [["NETWORK_POLICY_DENIES"], "NETWORK_POLICY_DENIES"],
    [["WORKER_GRAPH_UNAVAILABLE"], "WORKER_GRAPH_UNAVAILABLE"],
    [["DENIED_BY_WORKSPACE"], "DEPENDENCY_NOT_PERMITTED"],
    [
      ["NETWORK_POLICY_DENIES", "NOT_DISTRIBUTED"],
      "DEPENDENCY_NOT_DISTRIBUTED",
    ],
    [
      ["PROHIBITED_BY_INSTANCE", "WORKER_GRAPH_UNAVAILABLE"],
      "DEPENDENCY_PROHIBITED",
    ],
    [
      ["NETWORK_POLICY_DENIES", "WORKER_GRAPH_UNAVAILABLE"],
      "NETWORK_POLICY_DENIES",
    ],
  ] as const)("%j → %s", (blocked, code) => {
    const result = closure(
      [descriptor("a.root", { dependencies: ["a.dep"] }), descriptor("a.dep")],
      [axis("a.root"), axis("a.dep", blocked)],
      ["a.root"],
    );
    expect(result.rootConflicts.get("a.root")).toEqual([
      {
        code,
        capability: "a.root",
        subject: "a.dep",
        message: `\`a.dep\` is unavailable: ${blocked.join(", ")}`,
      },
    ]);
    expect([...result.members]).toEqual([]);
    expect([...result.reached].sort()).toEqual(["a.root"]);
  });

  it("a withdrawn core dependency is a prohibited one; an intact core one satisfies", () => {
    const d = [
      descriptor("a.root", { dependencies: ["core.one"] }),
      descriptor("core.one", { tier: "core" }),
    ];
    const withdrawn = closure(
      d,
      [axis("a.root"), axis("core.one", ["PROHIBITED_BY_INSTANCE"], "core")],
      ["a.root"],
    );
    expect(withdrawn.rootConflicts.get("a.root")?.[0]?.code).toBe(
      "DEPENDENCY_PROHIBITED",
    );
    const intact = closure(
      d,
      [axis("a.root"), axis("core.one", [], "core")],
      ["a.root"],
    );
    expect(intact.rootConflicts.size).toBe(0);
    // Core satisfies the edge; it is never a closure member itself.
    expect([...intact.members]).toEqual(["a.root"]);
  });
});

describe("ids the axes do not know", () => {
  it("a dependency is DEPENDENCY_NOT_DISTRIBUTED, a chosen alternative ALTERNATIVE_NOT_ALLOWED", () => {
    const result = closure(
      [
        descriptor("a.root", {
          dependencies: ["ghost.dep"],
          alternatives: [{ slot: "via", oneOf: ["ghost.alt"] }],
        }),
      ],
      [axis("a.root")],
      ["a.root"],
      { via: "ghost.alt" },
    );
    expect(result.rootConflicts.get("a.root")).toEqual([
      {
        code: "DEPENDENCY_NOT_DISTRIBUTED",
        capability: "a.root",
        subject: "ghost.dep",
        message: "`ghost.dep` is not in the catalog",
      },
      {
        code: "ALTERNATIVE_NOT_ALLOWED",
        capability: "a.root",
        subject: "ghost.alt",
        message: "`ghost.alt` is not in the catalog",
      },
    ]);
  });

  it("a blocked chosen alternative is ALTERNATIVE_NOT_ALLOWED whatever blocks it", () => {
    const result = closure(
      [
        descriptor("a.root", {
          alternatives: [{ slot: "via", oneOf: ["a.alt"] }],
        }),
        descriptor("a.alt"),
      ],
      [axis("a.root"), axis("a.alt", ["NOT_DISTRIBUTED"])],
      ["a.root"],
      { via: "a.alt" },
    );
    expect(result.rootConflicts.get("a.root")?.[0]?.code).toBe(
      "ALTERNATIVE_NOT_ALLOWED",
    );
  });

  it("a root the axes know but the index does not is walked as a leaf", () => {
    const result = closure([], [axis("a.root")], ["a.root"]);
    expect([...result.members]).toEqual(["a.root"]);
  });
});

describe("alternatives slots", () => {
  it("unchosen slots conflict in slot order, with the exact message", () => {
    const result = closure(
      [
        descriptor("a.root", {
          alternatives: [
            { slot: "zeta", oneOf: ["a.one"] },
            { slot: "alpha", oneOf: ["a.one"] },
          ],
        }),
      ],
      [axis("a.root")],
      ["a.root"],
    );
    expect(result.rootConflicts.get("a.root")).toEqual([
      {
        code: "ALTERNATIVE_NOT_CHOSEN",
        capability: "a.root",
        subject: "alpha",
        message: "`a.root` needs a choice for slot `alpha`",
      },
      {
        code: "ALTERNATIVE_NOT_CHOSEN",
        capability: "a.root",
        subject: "zeta",
        message: "`a.root` needs a choice for slot `zeta`",
      },
    ]);
  });

  it("a choice outside the slot's options names slot and root", () => {
    const result = closure(
      [
        descriptor("a.root", {
          alternatives: [{ slot: "via", oneOf: ["a.one"] }],
        }),
        descriptor("a.two"),
      ],
      [axis("a.root"), axis("a.two")],
      ["a.root"],
      { via: "a.two" },
    );
    expect(result.rootConflicts.get("a.root")).toEqual([
      {
        code: "ALTERNATIVE_NOT_ALLOWED",
        capability: "a.root",
        subject: "a.two",
        message: "`a.two` is not an option for slot `via` of `a.root`",
      },
    ]);
  });

  it("a chosen alternative's own dependencies join the closure", () => {
    const result = closure(
      [
        descriptor("a.root", {
          alternatives: [{ slot: "via", oneOf: ["a.alt"] }],
        }),
        descriptor("a.alt", { dependencies: ["a.deep"] }),
        descriptor("a.deep"),
      ],
      [axis("a.root"), axis("a.alt"), axis("a.deep")],
      ["a.root"],
      { via: "a.alt" },
    );
    expect([...result.members].sort()).toEqual(["a.alt", "a.deep", "a.root"]);
    expect([...(result.dependents.get("a.alt") ?? [])]).toEqual(["a.root"]);
  });
});

describe("walking", () => {
  it("follows dependencies transitively", () => {
    const result = closure(
      [
        descriptor("a.root", { dependencies: ["a.mid"] }),
        descriptor("a.mid", { dependencies: ["a.leaf"] }),
        descriptor("a.leaf"),
      ],
      [axis("a.root"), axis("a.mid"), axis("a.leaf")],
      ["a.root"],
    );
    expect([...result.members].sort()).toEqual(["a.leaf", "a.mid", "a.root"]);
  });

  it("records every dependent of a shared dependency", () => {
    const result = closure(
      [
        descriptor("a.one", { dependencies: ["a.shared"] }),
        descriptor("a.two", { dependencies: ["a.shared"] }),
        descriptor("a.shared"),
      ],
      [axis("a.one"), axis("a.two"), axis("a.shared")],
      ["a.one", "a.two"],
    );
    expect([...(result.dependents.get("a.shared") ?? [])].sort()).toEqual([
      "a.one",
      "a.two",
    ]);
  });

  it("a cycle below the root terminates", () => {
    const result = closure(
      [
        descriptor("a.root", { dependencies: ["a.x"] }),
        descriptor("a.x", { dependencies: ["a.y"] }),
        descriptor("a.y", { dependencies: ["a.x"] }),
      ],
      [axis("a.root"), axis("a.x"), axis("a.y")],
      ["a.root"],
    );
    expect([...result.members].sort()).toEqual(["a.root", "a.x", "a.y"]);
  });

  it("a cycle back to the root visits the root once, so its conflicts are not repeated", () => {
    const result = closure(
      [
        descriptor("a.root", {
          dependencies: ["a.x"],
          alternatives: [{ slot: "via", oneOf: ["a.x"] }],
        }),
        descriptor("a.x", { dependencies: ["a.root"] }),
      ],
      [axis("a.root"), axis("a.x")],
      ["a.root"],
    );
    expect(result.rootConflicts.get("a.root")).toHaveLength(1);
  });

  it("skips a core or blocked root, and reaches a conflicting root's members", () => {
    const result = closure(
      [
        descriptor("core.one", { tier: "core" }),
        descriptor("a.blocked"),
        descriptor("a.root", { dependencies: ["a.ok", "a.bad"] }),
        descriptor("a.ok"),
        descriptor("a.bad"),
      ],
      [
        axis("core.one", [], "core"),
        axis("a.blocked", ["DENIED_BY_WORKSPACE"]),
        axis("a.root"),
        axis("a.ok"),
        axis("a.bad", ["DENIED_BY_WORKSPACE"]),
      ],
      ["core.one", "a.blocked", "a.root"],
    );
    expect([...result.members]).toEqual([]);
    expect([...result.reached].sort()).toEqual(["a.ok", "a.root"]);
    expect([...result.rootConflicts.keys()]).toEqual(["a.root"]);
  });
});

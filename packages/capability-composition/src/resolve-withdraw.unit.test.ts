/**
 * withdrawnCore pinned on its own (carried from #470's exact-pin suites, so
 * the mutation slice can reach 100): only modular core is withdrawn, the
 * cascade needs one withdrawn dependency — not all — and it runs to a fixed
 * point whatever order the index lists the chain in.
 */
import { describe, expect, it } from "vitest";
import { FIXTURE_POLICIES, fixtureResolveInput } from "./fixtures.js";
import { withdrawnCore } from "./resolve-withdraw.js";
import type { CapabilityDescriptor, CapabilityId } from "./types.js";

function core(
  id: CapabilityId,
  over: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor {
  return {
    id,
    descriptorVersion: 1,
    tier: "core",
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

function withdrawn(
  descriptors: readonly CapabilityDescriptor[],
  prohibited: readonly CapabilityId[],
  policyValid = true,
): CapabilityId[] {
  const family = FIXTURE_POLICIES.family;
  const input = fixtureResolveInput({
    instancePolicy: {
      ...family,
      capabilities: { ...family.capabilities, prohibited },
    },
    policyValid,
  });
  const index = new Map(descriptors.map((d) => [d.id, d]));
  return [...withdrawnCore(input, index)].sort();
}

describe("withdrawnCore", () => {
  it("withdraws only modular core: not statically linked core, not an id the index lacks", () => {
    expect(
      withdrawn(
        [core("c.linked", { moduleIds: [] }), core("c.modular")],
        ["c.linked", "c.modular", "c.absent"],
      ),
    ).toEqual(["c.modular"]);
  });

  it("withdraws nothing under an unverified policy", () => {
    expect(withdrawn([core("c.modular")], ["c.modular"], false)).toEqual([]);
  });

  it("cascades to core needing any withdrawn dependency, and to nothing else", () => {
    expect(
      withdrawn(
        [
          core("c.gone"),
          core("c.kept"),
          core("c.needs-one", { dependencies: ["c.gone", "c.kept"] }),
          core("c.unrelated", { dependencies: ["c.kept"] }),
        ],
        ["c.gone"],
      ),
    ).toEqual(["c.gone", "c.needs-one"]);
  });

  it("runs the cascade to a fixed point even when the chain is listed backwards", () => {
    expect(
      withdrawn(
        [
          core("c.three", { dependencies: ["c.two"] }),
          core("c.two", { dependencies: ["c.one"] }),
          core("c.one"),
        ],
        ["c.one"],
      ),
    ).toEqual(["c.one", "c.three", "c.two"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  type CompartmentTopology,
  assertIndependentIsolation,
  canBootstrapActivationWithoutProtectedRoot,
  createIndependentNode,
  createSharedRootNode,
  listIndependentCompartmentRefs,
} from "./topology.js";

describe("KEYS-A compartment topology", () => {
  it("rejects shared-root isolation claims", () => {
    const topology: CompartmentTopology = {
      vaultRef: "v1",
      nodes: [
        createSharedRootNode({
          compartmentRef: "c-shared",
          sharedRootRef: "root-1",
          keyEpoch: 1,
        }),
        createIndependentNode({ compartmentRef: "c-ind", keyEpoch: 1 }).node,
      ],
    };
    expect(() => assertIndependentIsolation(topology, ["c-shared"])).toThrow(
      /independent_keys_required/,
    );
    assertIndependentIsolation(topology, ["c-ind"]);
    expect(listIndependentCompartmentRefs(topology)).toEqual(["c-ind"]);
  });

  it("allows activation bootstrap only for independent keys (KEYS-B)", () => {
    const { node } = createIndependentNode({
      compartmentRef: "c1",
      keyEpoch: 2,
    });
    const topology: CompartmentTopology = {
      vaultRef: "v1",
      nodes: [
        node,
        createSharedRootNode({
          compartmentRef: "c2",
          sharedRootRef: "root",
          keyEpoch: 2,
        }),
      ],
    };
    expect(canBootstrapActivationWithoutProtectedRoot(topology, ["c1"])).toBe(
      true,
    );
    expect(
      canBootstrapActivationWithoutProtectedRoot(topology, ["c1", "c2"]),
    ).toBe(false);
  });

  it("mints distinct independent keys", () => {
    const a = createIndependentNode({ compartmentRef: "a", keyEpoch: 1 });
    const b = createIndependentNode({ compartmentRef: "b", keyEpoch: 1 });
    expect(a.rootKey.length).toBe(32);
    expect([...a.rootKey]).not.toEqual([...b.rootKey]);
  });
});

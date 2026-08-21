import { describe, expect, it } from "vitest";
import {
  type RecoveryGraph,
  analyzeCycles,
  calculateIndependentRoots,
  findArticulationPoints,
  stronglyConnectedComponents,
  validateRecoveryGraph,
} from "../index.js";

const graph: RecoveryGraph = {
  nodes: [
    {
      id: "account",
      kind: "account",
      displayName: "Account",
      independentRoot: false,
    },
    {
      id: "gmail",
      kind: "mailbox",
      displayName: "Gmail",
      independentRoot: false,
    },
    {
      id: "manager",
      kind: "password_manager",
      displayName: "Manager",
      independentRoot: false,
    },
    {
      id: "key",
      kind: "hardware_key",
      displayName: "Hardware key",
      independentRoot: true,
    },
    {
      id: "phone",
      kind: "phone",
      displayName: "Phone",
      independentRoot: false,
    },
  ],
  edges: [
    { from: "account", to: "manager", kind: "requires" },
    { from: "manager", to: "gmail", kind: "recovers" },
    { from: "gmail", to: "account", kind: "delivers_second_factor" },
    { from: "account", to: "phone", kind: "requires" },
    { from: "phone", to: "key", kind: "authenticates" },
  ],
};

describe("recovery graph", () => {
  it("validates, rejects duplicate declarations, and normalizes valid input", () => {
    const result = validateRecoveryGraph({
      ...graph,
      nodes: [...graph.nodes].reverse(),
    });
    expect(result.valid).toBe(true);
    expect(result.graph?.nodes.map((node) => node.id)).toEqual([
      "account",
      "gmail",
      "key",
      "manager",
      "phone",
    ]);
    const invalid = validateRecoveryGraph({
      ...graph,
      edges: [...graph.edges, graph.edges[0]],
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.map((error) => error.code)).toContain(
      "duplicate_edge",
    );
  });

  it("finds SCCs and classifies a dependency loop as hard", () => {
    const result = analyzeCycles(graph);
    expect(result.components.map((component) => component.nodeIds)).toEqual([
      ["account", "gmail", "manager"],
      ["key"],
      ["phone"],
    ]);
    expect(result.cycles).toEqual([
      {
        component: result.components[0],
        kind: "hard_recovery_cycle",
        reason: "recovery_dependency_without_root",
      },
    ]);
  });

  it("finds articulation points and bridge edges in the undirected dependency view", () => {
    expect(findArticulationPoints(graph)).toEqual({
      articulationPointIds: ["account", "phone"],
      bridgeEdges: [
        { from: "account", to: "phone" },
        { from: "key", to: "phone" },
      ],
    });
  });

  it("calculates terminal components requiring independent roots deterministically", () => {
    expect(calculateIndependentRoots(graph)).toEqual({
      independentRootIds: ["key"],
      terminalComponentIds: [1],
      selectedRootIds: ["key"],
      uncoveredTerminalComponentIds: [],
      minimumIndependentRootCount: 1,
    });
  });

  it("is permutation-invariant for analysis output", () => {
    const reversed: RecoveryGraph = {
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };
    expect(stronglyConnectedComponents(reversed)).toEqual(
      stronglyConnectedComponents(graph),
    );
    expect(findArticulationPoints(reversed)).toEqual(
      findArticulationPoints(graph),
    );
    expect(calculateIndependentRoots(reversed)).toEqual(
      calculateIndependentRoots(graph),
    );
  });
});

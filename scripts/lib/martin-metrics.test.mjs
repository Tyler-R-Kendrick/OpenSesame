import { describe, expect, it } from "vitest";
import {
  couplings,
  cycles,
  mainSequenceDistance,
  sdpViolations,
} from "./martin-metrics.mjs";

/** Terse graph builder: { a: ["b"], b: [] } -> the component array. */
const graph = (edges) =>
  Object.entries(edges).map(([name, deps]) => ({ name, deps }));

describe("couplings", () => {
  it("counts afferent and efferent edges and derives instability", () => {
    // b is depended on by a and c, and depends on nothing: maximally stable.
    const metrics = couplings(graph({ a: ["b"], b: [], c: ["b"] }));
    expect(metrics.get("b")).toEqual({ ca: 2, ce: 0, instability: 0 });
    expect(metrics.get("a")).toEqual({ ca: 0, ce: 1, instability: 1 });
  });

  it("ignores dependencies outside the component graph", () => {
    const metrics = couplings(graph({ a: ["b", "serde", "react"], b: [] }));
    expect(metrics.get("a").ce).toBe(1);
  });

  it("treats a component with no couplings as stable rather than 0/0", () => {
    const metrics = couplings(graph({ lonely: [] }));
    expect(metrics.get("lonely")).toEqual({ ca: 0, ce: 0, instability: 0 });
  });
});

describe("cycles (ADP)", () => {
  it("finds nothing in a DAG", () => {
    expect(cycles(graph({ a: ["b", "c"], b: ["c"], c: [] }))).toEqual([]);
  });

  it("finds nothing in a wide diamond, where path enumeration would explode", () => {
    // Ten diamonds in series: exponentially many distinct paths, zero cycles.
    const edges = {};
    for (let i = 0; i < 10; i++) {
      edges[`top${i}`] = [`left${i}`, `right${i}`];
      edges[`left${i}`] = [`top${i + 1}`];
      edges[`right${i}`] = [`top${i + 1}`];
    }
    edges.top10 = [];
    expect(cycles(graph(edges))).toEqual([]);
  });

  it("reports a two-node cycle with a walkable example path", () => {
    const found = cycles(graph({ a: ["b"], b: ["a"] }));
    expect(found).toHaveLength(1);
    expect(found[0].members).toEqual(["a", "b"]);
    expect(found[0].example).toEqual(["a", "b", "a"]);
  });

  it("reports a three-node cycle as one group", () => {
    const found = cycles(graph({ a: ["b"], b: ["c"], c: ["a"] }));
    expect(found).toHaveLength(1);
    expect(found[0].members).toEqual(["a", "b", "c"]);
    expect(found[0].example).toEqual(["a", "b", "c", "a"]);
  });

  it("reports a self-dependency", () => {
    const found = cycles(graph({ a: ["a"], b: [] }));
    expect(found).toEqual([{ members: ["a"], example: ["a", "a"] }]);
  });

  it("separates two disjoint cycles", () => {
    const found = cycles(
      graph({ a: ["b"], b: ["a"], x: ["y"], y: ["x"], free: ["a"] }),
    );
    expect(found.map((cycle) => cycle.members)).toEqual([
      ["a", "b"],
      ["x", "y"],
    ]);
  });

  it("finds a cycle reachable only through an acyclic prefix", () => {
    const found = cycles(graph({ entry: ["a"], a: ["b"], b: ["a"] }));
    expect(found.map((cycle) => cycle.members)).toEqual([["a", "b"]]);
  });

  it("is not confused by an edge leaving the graph", () => {
    expect(cycles(graph({ a: ["external"], b: [] }))).toEqual([]);
  });
});

describe("sdpViolations (SDP)", () => {
  it("flags an edge pointing at something less stable", () => {
    // stable:   ca 1, ce 1 -> I 0.50
    // volatile: ca 1, ce 2 -> I 0.67, so the edge climbs toward instability.
    const components = graph({
      stable: ["volatile"],
      volatile: ["leafOne", "leafTwo"],
      other: ["stable"],
      leafOne: [],
      leafTwo: [],
    });
    const metrics = couplings(components);
    expect(metrics.get("stable").instability).toBeCloseTo(0.5);
    expect(metrics.get("volatile").instability).toBeCloseTo(2 / 3);

    const violations = sdpViolations(components, metrics);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ from: "stable", to: "volatile" });
  });

  it("accepts an edge pointing at something more stable", () => {
    const components = graph({ app: ["core"], core: [] });
    expect(sdpViolations(components, couplings(components))).toEqual([]);
  });

  it("accepts equal instability", () => {
    const components = graph({ a: ["b"], b: ["c"], c: [] });
    const metrics = couplings(components);
    // b: ca 1, ce 1 -> I 0.5; c: ca 1, ce 0 -> I 0. Neither edge climbs.
    expect(metrics.get("b").instability).toBe(0.5);
    expect(sdpViolations(components, metrics)).toEqual([]);
  });
});

describe("mainSequenceDistance (SAP)", () => {
  it("is zero on the main sequence", () => {
    // A fully abstract, fully stable component: A=1, I=0.
    expect(mainSequenceDistance(1, { ca: 3, ce: 0 })).toBe(0);
    // A fully concrete, fully unstable one: A=0, I=1.
    expect(mainSequenceDistance(0, { ca: 0, ce: 3 })).toBe(0);
  });

  it("is one in the zone of pain: stable and concrete", () => {
    expect(mainSequenceDistance(0, { ca: 5, ce: 0 })).toBe(1);
  });

  it("is one in the zone of uselessness: unstable and abstract", () => {
    expect(mainSequenceDistance(1, { ca: 0, ce: 5 })).toBe(1);
  });

  it("is undefined, not maximal, for a component with no couplings", () => {
    // Scoring an isolated leaf 1.00 would bury the genuinely unbalanced ones.
    expect(mainSequenceDistance(0, { ca: 0, ce: 0 })).toBeNull();
  });
});

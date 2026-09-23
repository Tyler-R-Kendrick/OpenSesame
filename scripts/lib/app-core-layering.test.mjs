import { describe, expect, it } from "vitest";
import {
  compareLedger,
  cycles,
  importEdges,
  layeringReport,
} from "./app-core-layering.mjs";

const files = (entries) => new Map(Object.entries(entries));

describe("importEdges", () => {
  it("tells static, type-only and lazy imports apart", () => {
    const edges = importEdges(
      files({
        "src/a.ts": [
          'import { b } from "./b.js";',
          'import type { C } from "./c.js";',
          'import { type D } from "./d.js";',
          'export { e } from "./e.js";',
          'const f = await import("./f.js");',
          'type G = import("./g.js").G;',
          'import { t } from "./a.test.js";',
        ].join("\n"),
        "src/b.ts": "",
        "src/c.ts": "",
        "src/d.ts": "",
        "src/e.ts": "",
        "src/f.ts": "",
        "src/g.ts": "",
        "src/a.test.ts": "",
      }),
    );
    expect(edges.map(({ to, kind }) => `${to}:${kind}`)).toEqual([
      "src/b.ts:static",
      "src/c.ts:type",
      "src/d.ts:type",
      "src/e.ts:static",
      "src/f.ts:dynamic",
      "src/g.ts:type",
    ]);
  });

  it("resolves directory imports to their index", () => {
    const edges = importEdges(
      files({
        "src/a.ts": 'import { x } from "./dir/index.js";',
        "src/dir/index.ts": 'import { a } from "../a.js";',
      }),
    );
    expect(edges.map(({ from, to }) => `${from}>${to}`)).toEqual([
      "src/a.ts>src/dir/index.ts",
      "src/dir/index.ts>src/a.ts",
    ]);
  });
});

describe("cycles", () => {
  it("finds each strongly connected group once", () => {
    const edges = [
      { from: "a", to: "b", kind: "static" },
      { from: "b", to: "a", kind: "static" },
      { from: "b", to: "c", kind: "static" },
      { from: "c", to: "c2", kind: "dynamic" },
      { from: "c2", to: "c", kind: "static" },
    ];
    expect(cycles(edges, ["static"])).toEqual([["a", "b"]]);
    expect(cycles(edges, ["static", "dynamic"])).toEqual([
      ["c", "c2"],
      ["a", "b"],
    ]);
  });
});

describe("layeringReport", () => {
  it("fails static cycles and records the lazy edges that close a loop", () => {
    const report = layeringReport(
      files({
        "src/store.ts": 'import { id } from "./identity.js";',
        "src/identity.ts": 'const s = await import("./store.js");',
        "src/lazy-leaf.ts": 'const x = await import("./leaf.js");',
        "src/leaf.ts": "",
        "src/x.ts": 'import { y } from "./y.js";',
        "src/y.ts": 'import { x } from "./x.js";',
      }),
    );
    expect(report.staticCycles).toEqual([["src/x.ts", "src/y.ts"]]);
    expect(report.lazyCycleEdges).toEqual(["src/identity.ts -> src/store.ts"]);
  });
});

describe("compareLedger", () => {
  it("reports new edges and edges that are gone", () => {
    expect(compareLedger(["a -> b", "c -> d"], ["a -> b", "e -> f"])).toEqual({
      added: ["c -> d"],
      removed: ["e -> f"],
    });
  });
});

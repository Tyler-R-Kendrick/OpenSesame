import { describe, expect, it } from "vitest";
import { readRelocationMap, relocateBaseline } from "./relocate-baseline.mjs";

const gone = () => false;

describe("relocateBaseline", () => {
  it("carries a recorded entry to its new path unchanged", () => {
    const { files, moved, refusals } = relocateBaseline(
      { "a/store.ts": { "max-lines": 1726, complexity: 2 } },
      { "a/store.ts": "b/store.ts" },
      gone,
    );
    expect(refusals).toEqual([]);
    expect(moved).toBe(1);
    expect(files).toEqual({
      "b/store.ts": { "max-lines": 1726, complexity: 2 },
    });
  });

  it("leaves unrelated entries alone", () => {
    const { files } = relocateBaseline(
      { "a/x.ts": { "max-lines": 500 }, "c/y.ts": { complexity: 1 } },
      { "a/x.ts": "b/x.ts" },
      gone,
    );
    expect(files["c/y.ts"]).toEqual({ complexity: 1 });
  });

  it("moves a debt-free file without inventing an entry", () => {
    const { files, moved, refusals } = relocateBaseline(
      {},
      { "a/clean.ts": "b/clean.ts" },
      gone,
    );
    expect(refusals).toEqual([]);
    expect(moved).toBe(0);
    expect(files).toEqual({});
  });

  it("refuses when the old path still exists", () => {
    const { refusals } = relocateBaseline(
      { "a/x.ts": { "max-lines": 500 } },
      { "a/x.ts": "b/x.ts" },
      (path) => path === "a/x.ts",
    );
    expect(refusals).toEqual(["a/x.ts: still exists, so this is not a move"]);
  });

  it("refuses to overwrite an entry already at the destination", () => {
    const { refusals } = relocateBaseline(
      { "a/x.ts": { "max-lines": 500 }, "b/x.ts": { "max-lines": 450 } },
      { "a/x.ts": "b/x.ts" },
      gone,
    );
    expect(refusals).toEqual(["b/x.ts: already has a baseline entry"]);
  });

  it("refuses a path mapped to itself", () => {
    const { refusals } = relocateBaseline({}, { "a/x.ts": "a/x.ts" }, gone);
    expect(refusals).toEqual(["a/x.ts: maps to itself"]);
  });
});

describe("readRelocationMap", () => {
  it("reads a moves object", () => {
    expect(readRelocationMap({ moves: { "a/x.ts": "b/x.ts" } })).toEqual({
      "a/x.ts": "b/x.ts",
    });
  });

  it.each([
    [null],
    [{}],
    [{ moves: [] }],
    [{ moves: { "a/x.ts": 3 } }],
    [{ moves: { "/abs/x.ts": "b/x.ts" } }],
    [{ moves: { "a/x.ts": "b\\x.ts" } }],
    [{ moves: { "a\\x.ts": "b/x.ts" } }],
  ])("refuses a malformed map %j", (parsed) => {
    expect(() => readRelocationMap(parsed)).toThrow();
  });
});

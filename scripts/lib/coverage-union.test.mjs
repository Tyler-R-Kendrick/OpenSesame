import { expect, it } from "vitest";
import {
  ownerRuntimeCoverage,
  unionRuntimeCoverage,
} from "./coverage-union.mjs";
import { validateRuntimeCoverage } from "./ts-coverage-scope.mjs";

const path = "/workspace-fixture/packages/owner/src/runtime.ts";
const sha = "a".repeat(64);
const inventory = new Map([[path, sha]]);
const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } };
function file(s = [0, 0], f = 0, b = [0, 0]) {
  return {
    path,
    sourceSha256: sha,
    statementMap: {
      0: loc,
      1: {
        ...loc,
        start: { line: 2, column: 0 },
        end: { line: 2, column: 20 },
      },
    },
    fnMap: { 0: { name: "actualFunction", decl: loc, loc } },
    branchMap: { 0: { type: "if", loc, locations: [loc, loc] } },
    s: { 0: s[0], 1: s[1] },
    f: { 0: f },
    b: { 0: b },
  };
}

it("unions complementary runtime hits without changing any denominator or mutating reports", () => {
  const first = { [path]: file([3, 0], 3, [3, 0]) };
  const second = { [path]: file([0, 5], 5, [0, 5]) };
  const original = JSON.stringify([first, second]);
  const merged = unionRuntimeCoverage([first, second], inventory)[path];
  expect(merged.s).toEqual({ 0: 3, 1: 5 });
  expect(merged.f).toEqual({ 0: 5 });
  expect(merged.b).toEqual({ 0: [3, 5] });
  expect(merged.statementMap).toEqual(first[path].statementMap);
  expect(merged.fnMap).toEqual(first[path].fnMap);
  expect(merged.branchMap).toEqual(first[path].branchMap);
  expect(JSON.stringify([first, second])).toBe(original);
  expect(unionRuntimeCoverage([second, first], inventory)).toEqual({
    [path]: merged,
  });
});

it("retains all unexecuted sites and refuses empty owner instrumentation", () => {
  const merged = unionRuntimeCoverage([{ [path]: file() }], inventory);
  expect(merged[path].s).toEqual({ 0: 0, 1: 0 });
  expect(merged[path].f).toEqual({ 0: 0 });
  expect(merged[path].b).toEqual({ 0: [0, 0] });
  expect(() => validateRuntimeCoverage({}, [path], "owner")).toThrow(
    "No runtime instrumentation",
  );
  const crossOnly = ownerRuntimeCoverage(merged, ["/other-owner/runtime.ts"]);
  expect(crossOnly).toEqual({});
  expect(() =>
    validateRuntimeCoverage(crossOnly, ["/other-owner/runtime.ts"], "other"),
  ).toThrow("No runtime instrumentation");
});

it.each([null, [], 4, "counter-report"])(
  "rejects malformed report %j",
  (report) => {
    expect(() => unionRuntimeCoverage([report], inventory)).toThrow(
      "Malformed native coverage report",
    );
  },
);

it("rejects foreign files, wrong source bytes and key/path disagreement", () => {
  expect(() =>
    unionRuntimeCoverage(
      [{ [path]: { ...file(), path: "relative.ts" } }],
      inventory,
    ),
  ).toThrow("source identity");
  expect(() =>
    unionRuntimeCoverage([{ "/foreign.ts": file() }], inventory),
  ).toThrow("foreign");
  expect(() =>
    unionRuntimeCoverage(
      [{ [path]: { ...file(), path: "/foreign.ts" } }],
      inventory,
    ),
  ).toThrow("source identity");
  expect(() =>
    unionRuntimeCoverage(
      [{ [path]: { ...file(), sourceSha256: "b".repeat(64) } }],
      inventory,
    ),
  ).toThrow("source identity");
  expect(() =>
    unionRuntimeCoverage(
      [{ [path]: { ...file(), sourceSha256: undefined } }],
      inventory,
    ),
  ).toThrow("Invalid");
});

it.each(["statementMap", "fnMap", "branchMap"])(
  "rejects mismatched %s locations rather than discarding a report",
  (map) => {
    const next = file([1, 1], 1, [1, 1]);
    if (map === "statementMap")
      next.statementMap[0] = { ...loc, start: { line: 3, column: 0 } };
    if (map === "fnMap") next.fnMap[0].name = "differentFunction";
    if (map === "branchMap") next.branchMap[0].type = "differentBranch";
    expect(() =>
      unionRuntimeCoverage([{ [path]: file() }, { [path]: next }], inventory),
    ).toThrow("Incompatible native coverage source maps");
  },
);

it("rejects invalid hit counts, missing counter keys and branch dimensions", () => {
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "covered"]) {
    const next = file();
    next.s[0] = value;
    expect(() => unionRuntimeCoverage([{ [path]: next }], inventory)).toThrow(
      "Invalid",
    );
  }
  const missing = file();
  missing.f = {};
  expect(() => unionRuntimeCoverage([{ [path]: missing }], inventory)).toThrow(
    "counter keys",
  );
  const branches = file();
  branches.b[0] = [1];
  expect(() => unionRuntimeCoverage([{ [path]: branches }], inventory)).toThrow(
    "dimensions",
  );
});

it("retains native infinite end-column and implicit-else encodings without inventing locations", () => {
  const native = file([1, 0], 1, [1, 0]);
  native.statementMap[0] = { ...loc, end: { line: 1, column: null } };
  native.branchMap[0].locations = [loc, { start: {}, end: {} }];
  const merged = unionRuntimeCoverage([{ [path]: native }], inventory)[path];
  expect(merged.statementMap).toEqual(native.statementMap);
  expect(merged.branchMap).toEqual(native.branchMap);
  expect(merged.b).toEqual({ 0: [1, 0] });
  const malformed = file();
  malformed.branchMap[0].locations = [loc, { start: {}, end: { line: 1 } }];
  expect(() =>
    unionRuntimeCoverage([{ [path]: malformed }], inventory),
  ).toThrow("Invalid");
});

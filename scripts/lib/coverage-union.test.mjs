import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  createExactSiteUnion,
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
  expect(Object.values(merged.s).sort()).toEqual([3, 5]);
  expect(merged.f).toEqual({ 0: 5 });
  expect(merged.b).toEqual({ 0: [3, 5] });
  expect(Object.values(merged.statementMap)).toEqual(
    expect.arrayContaining(Object.values(first[path].statementMap)),
  );
  expect(merged.fnMap).toEqual(first[path].fnMap);
  expect(merged.branchMap).toEqual(first[path].branchMap);
  expect(JSON.stringify([first, second])).toBe(original);
  expect(unionRuntimeCoverage([second, first], inventory)).toEqual({
    [path]: merged,
  });
});

it("retains all unexecuted sites and refuses empty owner instrumentation", () => {
  const merged = unionRuntimeCoverage([{ [path]: file() }], inventory);
  expect(Object.values(merged[path].s)).toEqual([0, 0]);
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
  ).toThrow(/Invalid|Malformed/);
});

it.each(["statementMap", "fnMap"])(
  "retains distinct complete native %s metadata as additional sites",
  (map) => {
    const next = file([1, 1], 1, [1, 1]);
    if (map === "statementMap")
      next.statementMap[0] = { ...loc, start: { line: 3, column: 0 } };
    if (map === "fnMap") next.fnMap[0].name = "differentFunction";
    const merged = unionRuntimeCoverage(
      [{ [path]: file() }, { [path]: next }],
      inventory,
    )[path];
    expect(Object.values(merged[map])).toEqual(
      expect.arrayContaining([
        ...Object.values(file()[map]),
        ...Object.values(next[map]),
      ]),
    );
    expect(Object.keys(merged[map])).toHaveLength(
      map === "statementMap" ? 3 : 2,
    );
  },
);
it("rejects unknown native branch types without losing original validation", () => {
  const next = file();
  next.branchMap[0].type = "differentBranch";
  expect(() =>
    unionRuntimeCoverage([{ [path]: file() }, { [path]: next }], inventory),
  ).toThrow(/Invalid|Malformed/);
});
it("retains BOTH authentic converter variants instead of replacing whole maps or shrinking denominator", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/native-coverage-sites.json", import.meta.url),
      "utf8",
    ),
  );
  const reports = fixture.variants.map(({ file: native }) => ({
    [path]: { ...native, path },
  }));
  const merged = unionRuntimeCoverage(
    reports,
    new Map([[path, reports[0][path].sourceSha256]]),
  )[path];
  expect(Object.keys(merged.statementMap)).toHaveLength(112);
  expect(Object.keys(merged.fnMap)).toHaveLength(30);
  expect(Object.keys(merged.branchMap)).toHaveLength(38);
  const actualVariants = Object.values(merged.branchMap).filter(
    ({ type, loc: nativeLoc }) =>
      type === "cond-expr" && nativeLoc.start.line === 315,
  );
  expect(actualVariants).toHaveLength(2);
  expect(
    actualVariants.map(({ locations }) => locations[0].end.line).sort(),
  ).toEqual([316, 317]);
});

it("rejects invalid hit counts, missing counter keys and branch dimensions", () => {
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "covered"]) {
    const next = file();
    next.s[0] = value;
    expect(() => unionRuntimeCoverage([{ [path]: next }], inventory)).toThrow(
      /Invalid|Malformed/,
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
  expect(Object.values(merged.statementMap)).toEqual(
    expect.arrayContaining(Object.values(native.statementMap)),
  );
  expect(merged.branchMap).toEqual(native.branchMap);
  expect(merged.b).toEqual({ 0: [1, 0] });
  const malformed = file();
  malformed.branchMap[0].locations = [loc, { start: {}, end: { line: 1 } }];
  expect(() =>
    unionRuntimeCoverage([{ [path]: malformed }], inventory),
  ).toThrow(/Invalid|Malformed/);
});

it("poisons append failures and forbids partial finish or reuse", () => {
  const accumulator = createExactSiteUnion(inventory);
  accumulator.append({ [path]: file() });
  const bad = file();
  bad.b[0] = [-1, 0];
  expect(() => accumulator.append({ [path]: bad })).toThrow();
  expect(() => accumulator.finish()).toThrow("closed");
  expect(() => accumulator.append({ [path]: file() })).toThrow("closed");
});
it("seals successful finish, snapshots inventory, and copies complete metadata/context", () => {
  const sourceMap = new Map(inventory);
  const accumulator = createExactSiteUnion(sourceMap);
  const native = structuredClone(file());
  native.statementMap[0].extra = { value: "original" };
  const context = { nested: { value: "original" } };
  accumulator.append({ [path]: native }, context);
  sourceMap.set(path, "b".repeat(64));
  native.statementMap[0].extra.value = "changed";
  context.nested.value = "changed";
  const result = accumulator.finish();
  expect(
    Object.values(result.coverage[path].statementMap).find((site) => site.extra)
      .extra.value,
  ).toBe("original");
  expect(result.provenance[path].origins[0].context.nested.value).toBe(
    "original",
  );
  expect(() => result.provenance[path].origins.push({})).toThrow();
  expect(() => accumulator.finish()).toThrow("closed");
  const pinned = createExactSiteUnion(inventory);
  const changed = file();
  changed.sourceSha256 = "b".repeat(64);
  expect(() => pinned.append({ [path]: changed })).toThrow("source identity");
  expect(() => pinned.finish()).toThrow("closed");
});

it("retains the actual archived native signed absent-else arm without clamping", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/native-coverage-sites.json", import.meta.url),
      "utf8",
    ),
  );
  const native = fixture.signedImplicitElse.file;
  const merged = unionRuntimeCoverage(
    [{ [path]: { ...native, path } }],
    new Map([[path, native.sourceSha256]]),
  )[path];
  expect(Object.values(merged.b).some((hits) => hits[1] === -59)).toBe(true);
  const explicit = structuredClone(native);
  explicit.b["1"][0] = -1;
  expect(() =>
    unionRuntimeCoverage(
      [{ [path]: { ...explicit, path } }],
      new Map([[path, native.sourceSha256]]),
    ),
  ).toThrow("Negative explicit");
});
it.each([Number.POSITIVE_INFINITY, -0, undefined])(
  "rejects non-JSON or ambiguous native metadata %j",
  (value) => {
    const native = structuredClone(file());
    native.statementMap[0].extra = value;
    expect(() => unionRuntimeCoverage([{ [path]: native }], inventory)).toThrow(
      /Invalid|Malformed/,
    );
  },
);
it("rejects unsafe location integers and changed duplicate map correspondence", () => {
  const unsafe = structuredClone(file());
  unsafe.statementMap[0].start.line = Number.MAX_SAFE_INTEGER + 1;
  expect(() => unionRuntimeCoverage([{ [path]: unsafe }], inventory)).toThrow(
    /Invalid|Malformed/,
  );
  const duplicate = structuredClone(file());
  duplicate.statementMap[2] = structuredClone(duplicate.statementMap[0]);
  duplicate.s[2] = 1;
  const changed = structuredClone(duplicate);
  changed.statementMap[1].end.column += 1;
  expect(() =>
    unionRuntimeCoverage(
      [{ [path]: duplicate }, { [path]: changed }],
      inventory,
    ),
  ).toThrow("Ambiguous native duplicate");
});

it("a caller cannot upgrade captured inventory after a good append", () => {
  const sources = new Map(inventory);
  const union = createExactSiteUnion(sources);
  union.append({ [path]: file() });
  sources.set(path, "b".repeat(64));
  const changed = file();
  changed.sourceSha256 = "b".repeat(64);
  expect(() => union.append({ [path]: changed })).toThrow("source identity");
  expect(() => union.finish()).toThrow("closed");
});

it("preserves valid own JSON prototype-named extras without prototype mutation", () => {
  const native = structuredClone(file());
  Object.defineProperty(native.statementMap[0], "__proto__", {
    value: { tag: "native" },
    enumerable: true,
    writable: true,
  });
  Object.defineProperty(native, "__proto__", {
    value: { tag: "root" },
    enumerable: true,
    writable: true,
  });
  const union = createExactSiteUnion(inventory);
  union.append({ [path]: native });
  const result = union.finish();
  const map = Object.values(result.coverage[path].statementMap).find((site) =>
    Object.hasOwn(site, "__proto__"),
  );
  expect(map.__proto__).toEqual({ tag: "native" });
  expect(result.provenance[path].origins[0].nativeExtras.__proto__).toEqual({
    tag: "root",
  });
});
it("rejects sparse, extra-property, accessor and non-JSON metadata before losing fields", () => {
  const sparse = [];
  sparse.length = 1;
  const extra = [null];
  extra.tag = "omitted";
  for (const value of [sparse, extra]) {
    const native = structuredClone(file());
    native.statementMap[0].extra = value;
    expect(() => unionRuntimeCoverage([{ [path]: native }], inventory)).toThrow(
      /Invalid|Malformed/,
    );
  }
  const native = structuredClone(file());
  let calls = 0;
  Object.defineProperty(native.statementMap[0], "extra", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  expect(() => unionRuntimeCoverage([{ [path]: native }], inventory)).toThrow(
    /Invalid|Malformed/,
  );
  expect(calls).toBe(0);
});

it("validates report descriptors before reading entries and poisons rejection", () => {
  let calls = 0;
  const report = {};
  Object.defineProperty(report, path, {
    enumerable: true,
    get() {
      calls++;
      return file();
    },
  });
  const union = createExactSiteUnion(inventory);
  expect(() => union.append(report)).toThrow("Malformed");
  expect(calls).toBe(0);
  expect(() => union.finish()).toThrow("closed");
  for (const malformed of [[], Object.create(null)]) {
    expect(() => unionRuntimeCoverage([malformed], inventory)).toThrow(
      "Malformed",
    );
  }
});

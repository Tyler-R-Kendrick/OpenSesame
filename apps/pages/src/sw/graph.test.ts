import { describe, expect, it } from "vitest";
import { isDistPath, parseCapabilityGraph, resolvePlanAssets } from "./graph.js";
import {
  CONNECTORS_MODULE,
  CONNECTORS_PLAN_FILES,
  EXCLUDED_JS,
  EXCLUDED_MODULE,
  FIXTURE_GRAPH,
  MAIN_CSS,
  MAIN_JS,
  VENDOR_JS,
} from "./test-fixtures.js";

function graph() {
  const parsed = parseCapabilityGraph(FIXTURE_GRAPH);
  if (!parsed) throw new Error("fixture graph did not parse");
  return parsed;
}

describe("isDistPath", () => {
  it("accepts dist-relative files and refuses anything URL-like", () => {
    expect(isDistPath("assets/main-abc.js")).toBe(true);
    expect(isDistPath("index.html")).toBe(true);
    expect(isDistPath("/assets/main.js")).toBe(false);
    expect(isDistPath("https://evil.test/x.js")).toBe(false);
    expect(isDistPath("assets/../sw.js")).toBe(false);
    expect(isDistPath("assets//x.js")).toBe(false);
    expect(isDistPath("a b.js")).toBe(false);
  });
});

describe("parseCapabilityGraph", () => {
  it("drops chunks with URL-like files and non-graph inputs", () => {
    expect(parseCapabilityGraph(null)).toBe(null);
    expect(parseCapabilityGraph({ chunks: "x" })).toBe(null);
    const parsed = parseCapabilityGraph({
      chunks: [
        { file: "https://evil.test/x.js", modules: [] },
        { file: "assets/ok.js", imports: ["/abs.js", "assets/dep.js"], modules: [{ capability: null }] },
        "junk",
      ],
    });
    expect(parsed?.chunks).toEqual([
      {
        file: "assets/ok.js",
        isEntry: false,
        core: true,
        imports: ["assets/dep.js"],
        css: [],
        modules: [{ moduleId: null, capability: null }],
      },
    ]);
  });

  it("reads core from `core`, `ownership` or an all-core module list", () => {
    const parsed = parseCapabilityGraph({
      chunks: [
        { file: "a.js", core: true },
        { file: "b.js", ownership: "core" },
        { file: "c.js", modules: [{ capability: "x.y" }] },
        { file: "d.js" },
      ],
    });
    expect(parsed?.chunks.map((c) => c.core)).toEqual([true, true, false, false]);
  });
});

describe("resolvePlanAssets", () => {
  it("returns the plan's closure plus core entries, never the excluded chunk", () => {
    const resolved = resolvePlanAssets(graph(), [CONNECTORS_MODULE]);
    expect(resolved).toEqual({ ok: true, files: CONNECTORS_PLAN_FILES });
    expect(resolved.ok && resolved.files).not.toContain(EXCLUDED_JS);
  });

  it("with no modules returns only the core entries and their closure", () => {
    expect(resolvePlanAssets(graph(), [])).toEqual({
      ok: true,
      files: [MAIN_CSS, MAIN_JS, VENDOR_JS],
    });
  });

  it("matches by capability when the build recorded no module id", () => {
    const parsed = parseCapabilityGraph({
      chunks: [{ file: "assets/w.js", modules: [{ capability: "wallet.spending" }] }],
    });
    if (!parsed) throw new Error("unparsed");
    expect(resolvePlanAssets(parsed, [EXCLUDED_MODULE])).toEqual({
      ok: true,
      files: ["assets/w.js"],
    });
  });

  it("fails the whole request on any unknown id", () => {
    expect(resolvePlanAssets(graph(), [CONNECTORS_MODULE, "identity.siop/runtime"])).toEqual({
      ok: false,
      unknown: ["identity.siop/runtime"],
    });
  });

  it("keeps an import the graph has no chunk record for", () => {
    const parsed = parseCapabilityGraph({
      chunks: [{ file: "a.js", isEntry: true, core: true, imports: ["assets/vendor-x.js"] }],
    });
    if (!parsed) throw new Error("unparsed");
    expect(resolvePlanAssets(parsed, [])).toEqual({
      ok: true,
      files: ["a.js", "assets/vendor-x.js"],
    });
  });
});

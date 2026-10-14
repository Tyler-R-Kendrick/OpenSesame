import { describe, expect, it } from "vitest";
import {
  isDistPath,
  parseCapabilityGraph,
  resolvePlanAssets,
} from "./graph.js";
import {
  CONNECTORS_MODULE,
  CONNECTORS_PLAN_FILES,
  EXCLUDED_JS,
  EXCLUDED_MODULE,
  FIXTURE_GRAPH,
  MAIN_CSS,
  MAIN_JS,
  SHELL_ICON,
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
        {
          file: "assets/ok.js",
          imports: ["/abs.js", "assets/dep.js"],
          dynamicImports: ["https://evil.test/lazy.js", "assets/lazy.js"],
          importedAssets: ["../secret.wasm", "assets/parser.wasm"],
          modules: [{ capability: null }],
        },
        "junk",
      ],
    });
    expect(parsed?.chunks).toEqual([
      {
        file: "assets/ok.js",
        isEntry: false,
        core: true,
        onDemand: false,
        imports: ["assets/dep.js"],
        dynamicImports: ["assets/lazy.js"],
        css: [],
        assets: ["assets/parser.wasm"],
        modules: [{ moduleId: null, capability: null }],
      },
    ]);
  });

  it("reads the build's `importedCss` edge as well as `css`", () => {
    const parsed = parseCapabilityGraph({
      chunks: [
        { file: "a.js", importedCss: ["a.css"], css: ["b.css"], modules: [] },
      ],
    });
    expect(parsed?.chunks[0]?.css).toEqual(["a.css", "b.css"]);
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
    expect(parsed?.chunks.map((c) => c.core)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("includes only valid shell resource links, never other entries or arbitrary public files", () => {
    const parsed = parseCapabilityGraph({
      entries: [
        {
          html: "index.html",
          capability: null,
          assets: ["icon.svg", "https://evil.test/icon.svg", "../private.json"],
        },
        {
          html: "auth/redirect.html",
          capability: "identity.ambient-sso",
          assets: ["providers/auth0.svg"],
        },
        { html: "other.html", capability: null, assets: ["other.svg"] },
      ],
      publicFiles: [{ file: "providers/clerk.svg", capability: null }],
      chunks: [],
    });
    if (!parsed) throw new Error("unparsed");
    expect(resolvePlanAssets(parsed, [])).toEqual({
      ok: true,
      files: ["icon.svg"],
    });
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
      files: [MAIN_CSS, MAIN_JS, VENDOR_JS, SHELL_ICON],
    });
  });

  it("matches by capability when the build recorded no module id", () => {
    const parsed = parseCapabilityGraph({
      chunks: [
        { file: "assets/w.js", modules: [{ capability: "wallet.spending" }] },
      ],
    });
    if (!parsed) throw new Error("unparsed");
    expect(resolvePlanAssets(parsed, [EXCLUDED_MODULE])).toEqual({
      ok: true,
      files: ["assets/w.js"],
    });
  });

  it("fails the whole request on any unknown id", () => {
    expect(
      resolvePlanAssets(graph(), [CONNECTORS_MODULE, "identity.siop/runtime"]),
    ).toEqual({
      ok: false,
      unknown: ["identity.siop/runtime"],
    });
  });

  it("keeps an import the graph has no chunk record for", () => {
    const parsed = parseCapabilityGraph({
      chunks: [
        {
          file: "a.js",
          isEntry: true,
          core: true,
          imports: ["assets/vendor-x.js"],
        },
      ],
    });
    if (!parsed) throw new Error("unparsed");
    expect(resolvePlanAssets(parsed, [])).toEqual({
      ok: true,
      files: ["a.js", "assets/vendor-x.js"],
    });
  });

  it("follows approved lazy owners and shared dependencies without crossing excluded or on-demand edges", () => {
    const parsed = parseCapabilityGraph({
      chunks: [
        {
          file: "main.js",
          isEntry: true,
          core: true,
          dynamicImports: [
            "connector.js",
            "disabled.js",
            "note.js",
            "unknown.js",
          ],
        },
        {
          file: "connector.js",
          modules: [
            { moduleId: CONNECTORS_MODULE, capability: "connectors.external" },
          ],
          dynamicImports: ["shared.js", "mixed.js"],
        },
        {
          file: "shared.js",
          modules: [{ capability: null }],
          importedAssets: ["parser.wasm"],
        },
        { file: "disabled.js", modules: [{ capability: "wallet.spending" }] },
        {
          file: "mixed.js",
          modules: [
            { capability: "connectors.external" },
            { capability: "wallet.spending" },
          ],
        },
        {
          file: "note.js",
          onDemand: true,
          modules: [{ capability: null }],
        },
      ],
    });
    if (!parsed) throw new Error("unparsed");
    expect(resolvePlanAssets(parsed, [CONNECTORS_MODULE])).toEqual({
      ok: true,
      files: ["connector.js", "main.js", "parser.wasm", "shared.js"],
    });
    expect(resolvePlanAssets(parsed, [])).toEqual({
      ok: true,
      files: ["main.js"],
    });
  });
});

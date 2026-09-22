import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { canonicalJson } from "./lib/capability-graph.mjs";
import { verifyDist } from "./verify-capability-graph.mjs";

/**
 * A synthetic `dist/`: real files on disk whose imports the verifier must
 * lex itself, plus the graph the plugin would have written. Each test bends
 * one thing so the verifier's independence from the plugin's claim shows.
 */
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const mod = (id, classification, capability = null) => ({
  id,
  classification,
  capability,
  rationale: "test",
  size: 1,
});

function scaffold({
  graphPatch = (g) => g,
  filesPatch = (f) => f,
  distributionPatch = (d) => d,
} = {}) {
  const dist = mkdtempSync(join(tmpdir(), "verify-capability-"));
  dirs.push(dist);
  mkdirSync(join(dist, "assets"));
  const files = filesPatch({
    "index.html": `<!doctype html><html><head><script type="module" crossorigin src="/OpenSesame/assets/main-1.js"></script><link rel="modulepreload" crossorigin href="/OpenSesame/assets/vendor-1.js"></head></html>`,
    "assets/main-1.js": `import{a}from"./vendor-1.js";const l=()=>import("./cap-sharing.drops-1.js");export{l};`,
    "assets/vendor-1.js": "export const a=1;",
    "assets/cap-sharing.drops-1.js": "export const capabilityRuntime={};",
    "assets/main-1.css": "body{}",
    "sw.js": `self.addEventListener("install",()=>{});`,
    "icon.svg": "<svg/>",
  });
  const distribution = distributionPatch({
    distributionId: "dist:abc",
    mode: "hardened",
    capabilityIds: ["sharing.drops", "vault.passwords"],
    moduleIds: ["sharing.drops/runtime"],
    workerVariants: [{ id: "core-only", scriptPath: "sw.js", satisfies: [] }],
    basePath: "/OpenSesame/",
  });
  const graph = graphPatch({
    distributionId: "dist:abc",
    mode: "hardened",
    profile: "household",
    coreCapabilities: ["vault.passwords"],
    generatedAt: null,
    entries: [
      {
        html: "index.html",
        capability: null,
        scripts: ["assets/main-1.js"],
        preloads: ["assets/vendor-1.js"],
      },
    ],
    chunks: [
      {
        file: "assets/main-1.js",
        name: "main",
        isEntry: true,
        isDynamicEntry: false,
        imports: ["assets/vendor-1.js"],
        dynamicImports: ["assets/cap-sharing.drops-1.js"],
        importedCss: ["assets/main-1.css"],
        importedAssets: [],
        modules: [
          mod("apps/pages/src/main.tsx", "core"),
          mod("virtual:opensesame-capability-modules", "core"),
        ],
      },
      {
        file: "assets/vendor-1.js",
        name: "vendor",
        isEntry: false,
        isDynamicEntry: false,
        imports: [],
        dynamicImports: [],
        importedCss: [],
        importedAssets: [],
        modules: [mod("node_modules/react/index.js", "shared")],
      },
      {
        file: "assets/cap-sharing.drops-1.js",
        name: "cap-sharing.drops",
        isEntry: false,
        isDynamicEntry: true,
        imports: [],
        dynamicImports: [],
        importedCss: [],
        importedAssets: [],
        modules: [
          mod(
            "apps/pages/src/modules/sharing.drops/runtime.ts",
            "optional",
            "sharing.drops",
          ),
        ],
      },
    ],
    assets: [{ file: "assets/main-1.css", size: 6 }],
    workers: [{ variant: "core-only", file: "sw.js", capability: null }],
    publicFiles: [{ file: "icon.svg", capability: null }],
    moduleEdges: [
      {
        from: "virtual:opensesame-capability-modules",
        to: "apps/pages/src/modules/sharing.drops/runtime.ts",
        toCapability: "sharing.drops",
        kind: "dynamic",
        viaTable: true,
      },
    ],
    unclassified: [],
  });
  for (const [file, content] of Object.entries(files))
    writeFileSync(join(dist, file), content);
  writeFileSync(join(dist, "capability-graph.json"), canonicalJson(graph));
  writeFileSync(
    join(dist, "capability-distribution.json"),
    canonicalJson(distribution),
  );
  return dist;
}

const codes = (report) =>
  [
    ...report.mismatches.map((m) => m.code),
    ...report.violations
      .filter((v) => v.severity === "error")
      .map((v) => v.code),
  ].sort();

describe("verify-capability-graph", () => {
  test("a consistent hardened dist verifies clean and reports sizes", async () => {
    const dist = scaffold();
    const { report } = await verifyDist({
      dist,
      mode: "hardened",
      expectAbsent: ["connectors.external/runtime"],
    });
    assert.deepEqual(codes(report), []);
    assert.equal(report.ok, true);
    assert.equal(report.sizes.fileCount, 9, "includes the two JSON records");
    assert.ok(
      report.sizes.javascript > 0 &&
        report.sizes.javascriptGzip > 0 &&
        report.sizes.css === 6,
    );
    assert.equal(
      report.sizes.entryStatic,
      Buffer.byteLength(
        `import{a}from"./vendor-1.js";const l=()=>import("./cap-sharing.drops-1.js");export{l};`,
      ) + Buffer.byteLength("export const a=1;"),
    );
    assert.deepEqual(report.sizes.capabilityChunks, {
      "sharing.drops": Buffer.byteLength("export const capabilityRuntime={};"),
    });
    assert.deepEqual(report.expectAbsent, [
      {
        module: "connectors.external/runtime",
        capability: "connectors.external",
        absent: true,
        chunks: [],
        files: [],
        inTable: false,
      },
    ]);
    assert.deepEqual(report.workers, [
      { variant: "core-only", file: "sw.js", capability: null, present: true },
    ]);
  });

  test("the graph's claim is checked against what the chunk really imports", async () => {
    // Disk says main statically imports the optional chunk; the graph hides it.
    const dist = scaffold({
      filesPatch: (f) => ({
        ...f,
        "assets/main-1.js": `import{a}from"./vendor-1.js";import"./cap-sharing.drops-1.js";export{a};`,
      }),
    });
    const { report } = await verifyDist({ dist, mode: "hardened" });
    assert.deepEqual(codes(report), [
      "DYNAMIC_EDGE_MISMATCH",
      "ENTRY_STATIC_OPTIONAL",
      "STATIC_EDGE_MISMATCH",
    ]);
    assert.equal(report.ok, false);
  });

  test("a JS file on disk that no chunk, worker or public file accounts for is a violation", async () => {
    const dist = scaffold({
      filesPatch: (f) => ({ ...f, "assets/stray-1.js": "export const x=1;" }),
    });
    const { report } = await verifyDist({ dist, mode: "hardened" });
    assert.deepEqual(codes(report), ["UNACCOUNTED_CHUNK"]);
  });

  test("a referenced file that is missing on disk, and an HTML entry the graph forgot", async () => {
    const dist = scaffold({
      filesPatch: (f) => {
        const { "assets/main-1.css": _css, ...rest } = f;
        return rest;
      },
    });
    mkdirSync(join(dist, "auth"), { recursive: true });
    writeFileSync(
      join(dist, "auth/redirect.html"),
      `<script type="module" src="../assets/main-1.js"></script>`,
    );
    const { report } = await verifyDist({ dist, mode: "hardened" });
    assert.deepEqual(codes(report), ["MISSING_REFERENCE", "UNACCOUNTED_HTML"]);
  });

  test("BUILD-04: --expect-absent fails when the capability's chunk, module or table entry survives", async () => {
    const dist = scaffold();
    const { report } = await verifyDist({
      dist,
      mode: "hardened",
      expectAbsent: ["sharing.drops/runtime"],
    });
    assert.deepEqual(codes(report), ["EXPECTED_ABSENT"]);
    assert.equal(report.expectAbsent[0].absent, false);
    assert.deepEqual(report.expectAbsent[0].files, [
      "assets/cap-sharing.drops-1.js",
    ]);
  });

  test("EVID-02 from disk: an excluded module inside a harmless-named chunk fails hardened", async () => {
    const dist = scaffold({
      graphPatch: (g) => ({
        ...g,
        chunks: g.chunks.map((c) =>
          c.file === "assets/vendor-1.js"
            ? {
                ...c,
                modules: [
                  ...c.modules,
                  mod(
                    "apps/pages/src/lib/push.ts",
                    "optional",
                    "notifications.web-push",
                  ),
                ],
              }
            : c,
        ),
      }),
    });
    const { report } = await verifyDist({ dist, mode: "hardened" });
    assert.deepEqual(codes(report), [
      "ENTRY_STATIC_OPTIONAL",
      "EXCLUDED_MODULE_EMITTED",
      "EXCLUDED_REACHABLE",
    ]);
  });

  test("mode, profile and distribution id must agree with what was asked for", async () => {
    const dist = scaffold({
      distributionPatch: (d) => ({ ...d, distributionId: "dist:other" }),
    });
    const profile = join(dist, "profile.json");
    writeFileSync(profile, JSON.stringify({ name: "family-local" }));
    const { report } = await verifyDist({ dist, mode: "selective", profile });
    assert.deepEqual(codes(report), [
      "DISTRIBUTION_ID_MISMATCH",
      "MODE_MISMATCH",
      "PROFILE_MISMATCH",
    ]);
  });

  test("an import that leaves dist is reported", async () => {
    const dist = scaffold({
      filesPatch: (f) => ({
        ...f,
        "assets/vendor-1.js": `import "https://cdn.example/x.js";export const a=1;`,
      }),
    });
    const { report } = await verifyDist({ dist, mode: "hardened" });
    assert.deepEqual(codes(report), ["EXTERNAL_IMPORT"]);
  });

  test("a dist without the plugin's records is refused", async () => {
    const dist = mkdtempSync(join(tmpdir(), "verify-capability-"));
    dirs.push(dist);
    await assert.rejects(
      verifyDist({ dist }),
      /missing capability-graph\.json/,
    );
  });
});

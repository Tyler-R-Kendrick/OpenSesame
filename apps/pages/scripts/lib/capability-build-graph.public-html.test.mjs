import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import { verifyDist } from "../verify-capability-graph.mjs";
import { buildGraph } from "./capability-build-graph.mjs";
import { canonicalJson } from "./capability-graph.mjs";

const base = "/OpenSesame/";
const documents = ["404.html", "about.html", "contact.html", "privacy.html"];
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function write(root, file, content) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture({ declared = documents } = {}) {
  const root = mkdtempSync(join(tmpdir(), "public-html-graph-"));
  roots.push(root);
  const appRoot = join(root, "apps/pages");
  const dist = join(appRoot, "dist");
  const id = join(appRoot, "src/main.tsx");
  const state = {
    appRoot,
    mode: "hardened",
    profile: { name: "owned-public-core" },
    sets: { core: new Set(["vault.passwords"]), notes: [] },
    inventory: { source: "authored" },
    htmlEntries: [],
    workers: [],
    isExcluded: (capability) => capability !== null,
    publicFiles: declared.map((path) => ({ path, capability: null })),
    classify: () => ({
      id: "apps/pages/src/main.tsx",
      classification: "core",
      capability: null,
      rationale: "fixture core bootstrap",
    }),
    contract: {
      distributionId: "dist:owned-public-core",
      mode: "hardened",
      capabilityIds: ["vault.passwords"],
      moduleIds: [],
      workerVariants: [],
      basePath: base,
    },
  };
  const ctx = {
    getModuleIds: () => [id],
    getModuleInfo: () => ({ importedIds: [], dynamicallyImportedIds: [] }),
  };
  const mainCode = "export const ready=true;";
  const html = `<html><head><script type="module" src="${base}assets/main.js"></script></head></html>`;
  const bundle = {
    "index.html": { type: "asset", source: html },
    "assets/main.js": {
      type: "chunk",
      name: "main",
      isEntry: true,
      isDynamicEntry: false,
      imports: [],
      dynamicImports: [],
      modules: { [id]: { renderedLength: mainCode.length } },
    },
  };
  write(dist, "index.html", html);
  write(dist, "assets/main.js", mainCode);
  // Use the actual shipped public documents, not invented graph-only HTML.
  for (const file of documents) {
    const source = readFileSync(
      new URL(`../../public/${file}`, import.meta.url),
      "utf8",
    );
    write(join(appRoot, "public"), file, source);
    write(dist, file, source);
  }
  const emit = () => {
    const graph = buildGraph(ctx, bundle, state, base);
    write(dist, "capability-graph.json", canonicalJson(graph));
    write(dist, "capability-distribution.json", canonicalJson(state.contract));
    return graph;
  };
  const verify = async () =>
    (await verifyDist({ dist, base, mode: "hardened", expectAbsent: [] }))
      .report;
  return { appRoot, dist, state, bundle, emit, verify };
}
test("the actual hardened disk gate reproduces all four copied HTML omissions without declarations", async () => {
  const f = fixture({ declared: [] });
  f.emit();
  const report = await f.verify();
  assert.equal(report.ok, false);
  assert.equal(report.mismatches.length, 4);
  assert.ok(
    report.mismatches.every((entry) => entry.code === "UNACCOUNTED_HTML"),
  );
  for (const file of documents)
    assert.ok(
      report.mismatches.some((entry) =>
        entry.message.startsWith(`${file} on disk`),
      ),
    );
});
test("precisely owned copied public documents become parsed core entries and pass the actual hardened disk gate", async () => {
  const f = fixture();
  const graph = f.emit();
  assert.deepEqual(
    graph.entries
      .filter((entry) => entry.html !== "index.html")
      .map((entry) => entry.html)
      .sort(),
    documents,
  );
  for (const file of documents)
    assert.deepEqual(
      graph.entries.find((entry) => entry.html === file),
      { html: file, capability: null, scripts: [], preloads: [], assets: [] },
    );
  const report = await f.verify();
  assert.equal(report.ok, true);
  assert.deepEqual(report.mismatches, []);
  assert.ok(report.sizes.total > 0);
});
test("new undeclared copied HTML still fails rather than being blindly enumerated as trusted", async () => {
  const f = fixture();
  write(join(f.appRoot, "public"), "privacy-extra.html", "<html></html>");
  write(f.dist, "privacy-extra.html", "<html></html>");
  f.emit();
  const report = await f.verify();
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.mismatches.map((entry) => entry.code),
    ["UNACCOUNTED_HTML"],
  );
  assert.match(report.mismatches[0].message, /^privacy-extra.html on disk/);
});
test("real copied document script, preload and linked asset references are parsed and checked against disk", async () => {
  const f = fixture();
  const html = `<html><head><script type="module" src="${base}assets/main.js"></script><link rel="modulepreload" href="./assets/main.js"><link rel="stylesheet" href="./assets/site.css"></head></html>`;
  write(join(f.appRoot, "public"), "about.html", html);
  write(f.dist, "about.html", html);
  write(f.dist, "assets/site.css", "body{}");
  const graph = f.emit();
  assert.deepEqual(
    graph.entries.find((entry) => entry.html === "about.html"),
    {
      html: "about.html",
      capability: null,
      scripts: ["assets/main.js"],
      preloads: ["assets/main.js"],
      assets: ["assets/site.css"],
    },
  );
  assert.equal((await f.verify()).ok, true);
  write(
    f.dist,
    "about.html",
    html.replace("assets/main.js", "assets/changed.js"),
  );
  const altered = await f.verify();
  assert.equal(altered.ok, false);
  assert.ok(
    altered.mismatches.some((entry) => entry.code === "ENTRY_MISMATCH"),
  );
});
test("a second copy in the Rollup bundle has one entry and preserves its declared public owner", async () => {
  const f = fixture();
  f.state.publicFiles.find((file) => file.path === "about.html").capability =
    "connectors.external";
  f.bundle["about.html"] = { type: "asset", source: "<html></html>" };
  write(f.dist, "about.html", "<html></html>");
  const graph = f.emit();
  assert.equal(
    graph.entries.filter((entry) => entry.html === "about.html").length,
    1,
  );
  assert.equal(
    graph.entries.find((entry) => entry.html === "about.html").capability,
    "connectors.external",
  );
  const report = await f.verify();
  assert.equal(report.ok, false);
  assert.ok(
    report.violations.some((entry) => entry.code === "EXCLUDED_HTML_ENTRY"),
  );
});

test("byte-backed emitted HTML is parsed once and asset sizes reflect actual UTF-8/binary disk bytes", async () => {
  const f = fixture();
  const html = `<html><head><title>Owned · 🔒</title><script type="module" src="${base}assets/main.js"></script></head></html>`;
  const htmlBytes = new Uint8Array(Buffer.from(html));
  f.bundle["about.html"] = { type: "asset", source: htmlBytes };
  write(f.dist, "about.html", htmlBytes);
  const assets = [
    ["assets/unicode.txt", "på lås 🔒"],
    ["assets/raw.bin", new Uint8Array([0, 255, 128, 17])],
  ];
  for (const [file, source] of assets) {
    f.bundle[file] = { type: "asset", source };
    write(f.dist, file, source);
  }
  const graph = f.emit();
  assert.deepEqual(
    graph.entries.filter((entry) => entry.html === "about.html"),
    [
      {
        html: "about.html",
        capability: null,
        scripts: ["assets/main.js"],
        preloads: [],
        assets: [],
      },
    ],
  );
  assert.equal(
    graph.assets.some((entry) => entry.file === "about.html"),
    false,
  );
  for (const [file] of assets)
    assert.equal(
      graph.assets.find((entry) => entry.file === file).size,
      readFileSync(join(f.dist, file)).byteLength,
    );
  assert.equal((await f.verify()).ok, true);
});

test.each([
  ["null", null],
  ["missing", undefined],
  ["number", 37],
  ["array", ["<html></html>"]],
  ["byteLength-shaped object", { byteLength: 4 }],
  ["ArrayBuffer", new ArrayBuffer(4)],
  ["DataView", new DataView(new ArrayBuffer(4))],
])(
  "Rollup %s sources fail before HTML parsing or asset sizing",
  (_name, source) => {
    for (const file of ["about.html", "assets/invalid.bin"]) {
      const f = fixture();
      f.bundle[file] = { type: "asset", source };
      assert.throws(() => f.emit(), /invalid|expected/iu);
    }
  },
);

test("invalid Rollup objects are rejected without invoking coercion hooks", () => {
  const f = fixture();
  let coerced = false;
  f.bundle["about.html"] = {
    type: "asset",
    source: {
      valueOf: () => {
        coerced = true;
        return "<html></html>";
      },
    },
  };
  assert.throws(() => f.emit(), /invalid|expected/iu);
  assert.equal(coerced, false);
});

test.each(["emitted", "copied"])(
  "non-UTF-8 %s HTML fails instead of being parsed with replacement bytes",
  (kind) => {
    const f = fixture();
    const source = new Uint8Array([0x3c, 0x68, 0xc3, 0x28, 0x3e]);
    if (kind === "emitted") f.bundle["about.html"] = { type: "asset", source };
    else write(join(f.appRoot, "public"), "about.html", source);
    write(f.dist, "about.html", source);
    assert.throws(() => f.emit(), /encoded data was not valid/iu);
  },
);

test("byte-equivalent Worker assets still require exact original code metadata", () => {
  const f = fixture();
  const code = "self.postMessage('ready');";
  f.bundle["assets/worker.js"] = {
    type: "asset",
    source: new Uint8Array(Buffer.from(code)),
    opensesameWorkerChunk: { code, fileName: "assets/worker.js" },
  };
  assert.throws(() => f.emit(), /Worker asset bytes or source metadata differ/);
});

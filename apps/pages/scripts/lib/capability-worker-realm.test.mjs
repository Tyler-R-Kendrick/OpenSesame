import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { buildGraph } from "./capability-build-graph.mjs";
import {
  classifyModule,
  normalizeModuleId,
  workerRealmSource,
} from "./capability-graph.mjs";
import { violations } from "./capability-invariants.mjs";
import { measureSizes } from "./verify-dist-checks.mjs";

const repoRoot = "/repo";
const rules = [
  {
    pattern: "src/lib/secret-backends/",
    classification: "optional",
    capability: "connectors.external",
    rationale: "native connector",
  },
  {
    pattern: "node_modules/zod",
    classification: "shared",
    rationale: "schema parsing",
  },
  {
    pattern: "src/lib/zod-jitless",
    classification: "core",
    rationale: "CSP bootstrap",
  },
];
const realm = (source, suffix = ".ts") =>
  `\0opensesame-worker:onepassword-sdk.worker:${Buffer.from(source).toString("base64url")}${suffix}`;

test.each([
  [
    "/repo/packages/app-core/src/lib/secret-backends/onepassword-sdk.worker.ts",
    ".ts",
  ],
  [
    "/repo/apps/pages/src/modules/networking.tailnet/browser/worker.ts?identity=original",
    ".ts",
  ],
  ["/repo/packages/app-core/src/lib/zod-jitless.ts", ".ts"],
  ["/repo/node_modules/.pnpm/zod@4.4.3/node_modules/zod/index.js", ".js"],
  [
    "/repo/packages/app-core/src/lib/secret-backends/onepassword-artifacts.json",
    ".json",
  ],
])(
  "worker realm retains exact original source ownership: %s",
  (source, suffix) => {
    const id = realm(source, suffix);
    assert.equal(workerRealmSource(id), source);
    assert.equal(
      normalizeModuleId(id, { repoRoot }),
      normalizeModuleId(source, { repoRoot }),
    );
    assert.deepEqual(
      classifyModule(id, rules, { repoRoot }),
      classifyModule(source, rules, { repoRoot }),
    );
  },
);

test.each([
  "\0opensesame-worker",
  "\0opensesame-worker:bad",
  "\0opensesame-worker::L3JlcG8vYS50cw.ts",
  "\0opensesame-worker:worker:!!!.ts",
  realm("relative/worker.ts"),
  realm("/repo/worker.js"),
  realm("/repo/worker.ts\0"),
  realm("/repo/worker.ts").replace(".ts", "=.ts"),
])("malformed reserved worker IDs fail closed: %s", (id) => {
  assert.throws(
    () => normalizeModuleId(id, { repoRoot }),
    /Malformed worker realm/,
  );
  assert.throws(
    () => classifyModule(id, rules, { repoRoot }),
    /Malformed worker realm/,
  );
});

test("hardened exclusion still rejects an emitted owned worker realm", () => {
  const source =
    "/repo/apps/pages/src/modules/networking.tailnet/browser/worker.ts";
  const graph = {
    chunks: [
      {
        file: "assets/worker.js",
        imports: [],
        dynamicImports: [],
        importedCss: [],
        importedAssets: [],
        modules: [classifyModule(realm(source), rules, { repoRoot })],
      },
    ],
    entries: [],
    workers: [],
    publicFiles: [],
    moduleEdges: [],
    unclassified: [],
    coreCapabilities: [],
  };
  const errors = violations(graph, new Set(), "hardened");
  assert.ok(
    errors.some(
      (item) =>
        item.code === "EXCLUDED_MODULE_EMITTED" &&
        item.capability === "networking.tailnet",
    ),
  );
  assert.ok(
    !violations({ ...graph, chunks: [] }, new Set(), "hardened").some(
      (item) => item.code === "EXCLUDED_MODULE_EMITTED",
    ),
  );
});

test("ordinary virtual modules retain their existing classification", () => {
  assert.equal(
    workerRealmSource("\0virtual:opensesame-distribution"),
    undefined,
  );
  assert.deepEqual(
    classifyModule("\0virtual:opensesame-distribution", rules, { repoRoot }),
    {
      id: "virtual:opensesame-distribution",
      classification: "core",
      capability: null,
      rationale: "virtual",
    },
  );
});

function workerAsset(source = 'import "./pure.js";') {
  const id = realm(
    "/repo/apps/pages/src/modules/networking.tailnet/browser/worker.ts",
  );
  return {
    type: "asset",
    fileName: "assets/worker.js",
    source,
    opensesameWorkerChunk: {
      type: "chunk",
      fileName: "assets/worker.js",
      code: 'import "./pure.js";',
      name: "native-worker",
      isEntry: true,
      isDynamicEntry: false,
      facadeModuleId: id,
      imports: ["assets/pure.js"],
      dynamicImports: [],
      modules: { [id]: { renderedLength: 24 } },
      viteMetadata: { importedAssets: new Set(), importedCss: new Set() },
    },
  };
}
const state = {
  classify: (id) => classifyModule(id, rules, { repoRoot }),
  contract: { distributionId: "fixture" },
  mode: "hardened",
  profile: { name: "excluded", expectInvalid: false },
  sets: { core: new Set(), notes: [] },
  inventory: { source: "fixture" },
  htmlEntries: [],
  workers: [],
  publicFiles: [],
};
const ctx = { getModuleIds: () => [], getModuleInfo: () => undefined };
const pure = {
  type: "chunk",
  fileName: "assets/pure.js",
  name: "pure",
  isEntry: false,
  isDynamicEntry: false,
  imports: [],
  dynamicImports: [],
  modules: { "/repo/node_modules/zod/index.js": { renderedLength: 4 } },
  code: "void 0;",
};

test("opaque worker assets retain every classified module and dependency edge", () => {
  const graph = buildGraph(
    ctx,
    { "assets/worker.js": workerAsset(), "assets/pure.js": pure },
    state,
    "/",
  );
  const record = graph.chunks.find(
    (chunk) => chunk.file === "assets/worker.js",
  );
  assert.deepEqual(record.imports, ["assets/pure.js"]);
  assert.equal(
    record.modules[0].id,
    "apps/pages/src/modules/networking.tailnet/browser/worker.ts",
  );
  assert.equal(record.modules[0].capability, "networking.tailnet");
  assert.equal(
    graph.assets.filter((asset) => asset.file === "assets/worker.js").length,
    1,
  );
  assert.equal(
    graph.chunks.filter((chunk) => chunk.file === "assets/worker.js").length,
    1,
  );
  assert.deepEqual(graph.workers, [
    {
      variant: "module:native-worker",
      file: "assets/worker.js",
      capability: "networking.tailnet",
    },
  ]);
  const failures = violations(graph, new Set(), "hardened");
  assert.ok(failures.some((item) => item.code === "EXCLUDED_MODULE_EMITTED"));
  assert.ok(failures.some((item) => item.code === "EXCLUDED_WORKER"));
  assert.ok(failures.some((item) => item.code === "EXCLUDED_REACHABLE"));
});

test("worker asset byte or source metadata drift fails closed", () => {
  assert.throws(
    () =>
      buildGraph(
        ctx,
        { "assets/worker.js": workerAsset("changed bytes") },
        state,
        "/",
      ),
    /Worker asset bytes/,
  );
  const asset = workerAsset();
  asset.opensesameWorkerChunk.facadeModuleId = "\0unowned";
  assert.throws(
    () => buildGraph(ctx, { "assets/worker.js": asset }, state, "/"),
    /original entry source/,
  );
});

test("retained worker graph metadata does not count the emitted bytes twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-graph-accounting-"));
  try {
    await mkdir(join(directory, "assets"));
    const asset = workerAsset();
    const bundle = { "assets/worker.js": asset, "assets/pure.js": pure };
    for (const [file, output] of Object.entries(bundle))
      await writeFile(join(directory, file), output.source ?? output.code);
    const graph = buildGraph(ctx, bundle, state, "/");
    const files = Object.keys(bundle);
    const sizes = measureSizes(directory, files, graph, graph, new Set(files));
    assert.equal(
      sizes.total,
      Buffer.byteLength(asset.source) + Buffer.byteLength(pure.code),
    );
    assert.equal(sizes.javascript, sizes.total);
    assert.equal(sizes.fileCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

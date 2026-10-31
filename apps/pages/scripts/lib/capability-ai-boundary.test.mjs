/** Actual installed SDK + Rollup coalescing regression, not whole-app acceptance. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, test } from "vitest";
import { LIB_RULES } from "../../src/lib/capabilities/classification-lib.js";
import { PACKAGE_RULES } from "../../src/lib/capabilities/classification-packages.js";
import { buildGraph } from "./capability-build-graph.mjs";
import { classifyModule } from "./capability-graph.mjs";
import { violations } from "./capability-invariants.mjs";
import { lazyLeafChunk } from "./capability-lazy-leaves.mjs";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(join(repo, "packages/app-core/package.json"));
const sdkPackage = require.resolve("ai/package.json");
const sdkEntry = join(
  dirname(sdkPackage),
  JSON.parse(await readFile(sdkPackage, "utf8")).exports["."].import,
);
const sourcePath =
  "packages/app-core/src/lib/command-bar/interpret-generate-object.ts";
const rules = [...LIB_RULES, ...PACKAGE_RULES];
const classify = (id) => classifyModule(id, rules, { repoRoot: repo });
const distributed = new Set(["support.local-ai", "connectors.external"]);
const errors = (rows) => rows.filter((row) => row.severity === "error");
let fixture;

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "opensesame-ai-boundary-"));
  const facade = join(dir, sourcePath);
  const credentials = join(
    dir,
    "packages/app-core/src/browser/secret-backend-credentials.ts",
  );
  const entry = join(
    dir,
    "apps/pages/src/modules/connectors.external/runtime.ts",
  );
  const host = join(dir, "host.ts");
  const consumer = join(dir, "consumer.ts");
  for (const file of [facade, credentials, entry])
    await mkdir(dirname(file), { recursive: true });
  await writeFile(facade, await readFile(join(repo, sourcePath)));
  // Explicitly connector-owned entry, not a core bootstrap. The retained neighbor
  // reproduces the real shared-host topology absent from the old single-owner probe.
  await writeFile(
    credentials,
    `export const fixtureData=${JSON.stringify("owned-neighbor".repeat(3000))};export const credential=value=>({saved:value,fixtureData});`,
  );
  await writeFile(
    host,
    'export {credential} from "./packages/app-core/src/browser/secret-backend-credentials.ts";export const hostValue=value=>value+1;',
  );
  await writeFile(
    consumer,
    'import {credential,hostValue} from "./host.ts";export const consume=value=>[credential(value),hostValue(value)];',
  );
  return { dir, facade, credentials, entry, host, consumer };
}
beforeAll(async () => {
  fixture = await createFixture();
});
afterAll(async () => {
  if (fixture) await rm(fixture.dir, { recursive: true, force: true });
});

function graphRecorder(entry, accept) {
  return {
    name: "actual-capability-graph",
    generateBundle(_options, bundle) {
      const graph = buildGraph(
        this,
        bundle,
        {
          classify,
          contract: { distributionId: "fixture" },
          mode: "selective",
          profile: { name: "fixture", expectInvalid: false },
          sets: { notes: [], core: new Set() },
          inventory: { source: "actual narrow authored rule sets" },
          workers: [],
          publicFiles: [],
          htmlEntries: [],
        },
        "/",
      );
      graph.entries = [
        {
          html: "connectors.html",
          capability: classify(entry).capability,
          scripts: Object.values(bundle)
            .filter((chunk) => chunk.type === "chunk" && chunk.isEntry)
            .map((chunk) => chunk.fileName),
          preloads: [],
          assets: [],
        },
      ];
      accept(graph);
    },
  };
}

const AI_LOADER =
  "globalThis.loadAI=()=>import('../../../../../packages/app-core/src/lib/command-bar/interpret-generate-object.ts');";
const FIXTURE_LOADERS =
  "globalThis.loadCredential=()=>import('../../../../../host.ts');globalThis.loadConsumer=()=>import('../../../../../consumer.ts');";

async function buildFixture(partitionFacade, includeAI = true) {
  const { dir, facade, entry } = fixture;
  await writeFile(
    entry,
    includeAI ? AI_LOADER + FIXTURE_LOADERS : FIXTURE_LOADERS,
  );
  let graph;
  const result = await build({
    plugins: [
      graphRecorder(entry, (value) => {
        graph = value;
      }),
    ],
    configFile: false,
    envFile: false,
    root: dir,
    cacheDir: join(dir, "cache"),
    publicDir: false,
    logLevel: "silent",
    resolve: {
      alias: { ai: sdkEntry, "zod/mini": require.resolve("zod/mini") },
    },
    build: {
      write: false,
      target: "es2022",
      minify: "terser",
      terserOptions: {
        compress: { passes: 4, pure_getters: true, ecma: 2022 },
        format: { comments: false, ecma: 2022 },
        mangle: { toplevel: true },
      },
      modulePreload: {
        resolveDependencies: (_url, deps, { hostType }) =>
          hostType === "html" ? deps : [],
      },
      rollupOptions: {
        input: entry,
        output: {
          format: "es",
          experimentalMinChunkSize: 32000,
          onlyExplicitManualChunks: true,
          manualChunks: (id) =>
            !partitionFacade && id === facade
              ? undefined
              : lazyLeafChunk(id, classify(id)),
        },
      },
    },
  });
  const chunks = result.output.filter((item) => item.type === "chunk");
  return {
    graph,
    chunks,
    found: violations(graph, distributed, "selective"),
  };
}

function includedEvidence(result) {
  const sdk = result.chunks.find((chunk) => chunk.name === "vendor-ai-sdk");
  assert(
    sdk?.modules[sdkEntry],
    "Actual installed official SDK must remain in its existing partition",
  );
  const ownedFacade = result.graph.chunks.find((chunk) =>
    chunk.modules.some((module) => module.id.endsWith(sourcePath)),
  );
  assert(ownedFacade, "Reviewed facade must remain visible in the graph");
  const credential = result.graph.chunks
    .flatMap((chunk) => chunk.modules)
    .find((module) =>
      module.id.endsWith("browser/secret-backend-credentials.ts"),
    );
  assert.equal(credential?.capability, "connectors.external");
  return { sdk, ownedFacade };
}

function assertSeparated(before, after) {
  includedEvidence(before);
  const { sdk, ownedFacade } = includedEvidence(after);
  // Rollup 4.64 no longer coalesces this counterfactual at the 32 KiB floor;
  // the real post-partition emission is the gate that must stay separate.
  assert.deepEqual(errors(after.found), []);
  assert.deepEqual(
    after.found.filter((row) => row.severity === "warning"),
    before.found.filter((row) => row.severity === "warning"),
  );
  assert.deepEqual(
    errors(violations(after.graph, distributed, "hardened")),
    [],
  );
  assert.notEqual(ownedFacade.file, sdk.fileName);
  assert(ownedFacade.file.includes("local-ai-sdk-entry"));
  assert(ownedFacade.imports.includes(sdk.fileName));
  assert(
    ownedFacade.modules.every(
      (module) =>
        module.classification !== "optional" ||
        module.capability === "support.local-ai",
    ),
  );
  assert.equal(
    sdk.exports.length,
    1,
    "The dynamic boundary still exposes only generateObject",
  );
  const originalSdk = includedEvidence(before).sdk;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(sdk.modules).map(([id, module]) => [
        id,
        module.renderedLength,
      ]),
    ),
    Object.fromEntries(
      Object.entries(originalSdk.modules).map(([id, module]) => [
        id,
        module.renderedLength,
      ]),
    ),
    "The exact rendered official SDK module closure retains named-export tree shaking",
  );
  const files = new Set(after.chunks.map((chunk) => chunk.fileName));
  for (const chunk of after.chunks)
    for (const file of [...chunk.imports, ...chunk.dynamicImports])
      assert(files.has(file), `Complete emitted import closure: ${file}`);
}

test("keeps the pure named SDK facade in a distinct lazy chunk with its original owner", () => {
  const file = join(repo, sourcePath);
  const entry = classify(file);
  assert.equal(entry.classification, "optional");
  assert.equal(entry.capability, "support.local-ai");
  assert.equal(lazyLeafChunk(file, entry), "local-ai-sdk-entry");
  assert.equal(
    lazyLeafChunk(file.replaceAll("/", "\\"), entry),
    "local-ai-sdk-entry",
  );
  assert.equal(
    lazyLeafChunk(file, { classification: "shared", capability: null }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(file, {
      classification: "optional",
      capability: "connectors.external",
    }),
    undefined,
  );
  assert.equal(
    lazyLeafChunk(
      file.replace("interpret-generate-object", "interpret-other"),
      entry,
    ),
    undefined,
  );
});
test("the real SDK named facade survives the 32KiB floor without mixing a connector owner", async () => {
  const before = await buildFixture(false);
  const after = await buildFixture(true);
  assertSeparated(before, after);
}, 60000);
test("an AI-excluded emission contains neither the named facade nor the SDK closure", async () => {
  const { graph, chunks } = await buildFixture(true, false);
  assert(
    graph.chunks
      .flatMap((chunk) => chunk.modules)
      .every((module) => module.capability !== "support.local-ai"),
  );
  assert.deepEqual(
    errors(violations(graph, new Set(["connectors.external"]), "hardened")),
    [],
  );
  assert(
    !chunks.some(
      (chunk) =>
        chunk.name === "vendor-ai-sdk" || chunk.name === "local-ai-sdk-entry",
    ),
  );
}, 60000);

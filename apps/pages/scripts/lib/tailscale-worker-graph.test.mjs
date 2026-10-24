/** The Tailscale controller worker is a declared graph node, not merely a URL. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, resolveConfig } from "vite";
import { test } from "vitest";
import { sharedWorkerGraph } from "../shared-worker-graph.mjs";
import { buildGraph } from "./capability-build-graph.mjs";
import { emittedTailnetWorker } from "./tailscale-installed-pwa-browser.mjs";

test("Pages build registers the shared worker graph before Tailscale assets", async () => {
  const config = await resolveConfig(
    {
      configFile: fileURLToPath(
        new URL("../../vite.config.ts", import.meta.url),
      ),
      mode: "production",
    },
    "build",
  );
  const names = config.plugins.map((plugin) => plugin.name);
  const workerGraph = names.indexOf("opensesame-shared-worker-graph");
  assert.ok(workerGraph >= 0, "shared worker graph plugin is not registered");
  assert.ok(
    workerGraph < names.indexOf("opensesame-tailscale-wasm-assets"),
    "Tailscale assets must see the emitted worker chunk",
  );
}, 60_000);

/** Write the controller/worker fixture and build it through the plugin. */
async function buildFixtureWorker(directory) {
  const controller = join(
    directory,
    "src/modules/networking.tailnet/browser/controller.ts",
  );
  const worker = join(
    directory,
    "src/modules/networking.tailnet/browser/worker.ts",
  );
  await mkdir(dirname(controller), { recursive: true });
  await writeFile(
    controller,
    `export const start=()=>new Worker(new URL("./worker.ts",import.meta.url),{type:"module",name:"opensesame-tailscale"});`,
  );
  await writeFile(worker, `self.name="opensesame-tailscale";`);
  return build({
    configFile: false,
    root: directory,
    cacheDir: join(directory, "cache"),
    publicDir: false,
    logLevel: "silent",
    plugins: [
      sharedWorkerGraph({
        workers: [
          {
            owner: controller,
            specifier: "./worker.ts",
            name: "tailscale-node",
          },
        ],
      }),
    ],
    build: {
      write: false,
      target: "es2022",
      minify: false,
      rollupOptions: {
        input: controller,
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
        },
      },
    },
  });
}

test("the shared worker graph declares exactly one dedicated Tailscale worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tailnet-worker-graph-"));
  try {
    const result = await buildFixtureWorker(directory);
    const bundle = Object.fromEntries(
      result.output.map((item) => [item.fileName, item]),
    );
    const state = {
      contract: { distributionId: "fixture" },
      mode: "hardened",
      profile: { name: "fixture", expectInvalid: false },
      sets: { core: new Set(), notes: [] },
      inventory: { source: "fixture" },
      htmlEntries: [],
      workers: [],
      publicFiles: [],
      classify: (id) => ({
        id,
        classification: "optional",
        capability: "networking.tailnet",
        rationale: "fixture",
      }),
    };
    const graph = buildGraph(
      { getModuleIds: () => [], getModuleInfo: () => undefined },
      bundle,
      state,
      "/OpenSesame/",
    );
    const assets = graph.assets.filter((asset) =>
      /^assets\/tailscale-node-[A-Za-z0-9_-]+\.js$/.test(asset.file),
    );
    assert.equal(assets.length, 1);
    const declared = graph.workers.filter(
      (record) => record.variant === "module:tailscale-node",
    );
    assert.deepEqual(declared, [
      {
        variant: "module:tailscale-node",
        file: assets[0].file,
        capability: "networking.tailnet",
      },
    ]);
    for (const item of result.output) {
      const target = join(directory, item.fileName);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, item.type === "chunk" ? item.code : item.source);
    }
    await writeFile(
      join(directory, "capability-graph.json"),
      JSON.stringify({
        ...graph,
        workers: graph.workers.map((record) => ({ ...record, present: true })),
      }),
    );
    assert.equal(
      emittedTailnetWorker(directory, "/OpenSesame/"),
      assets[0].file,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { afterAll, it as test } from "vitest";
import { bitwardenWorkerAssets } from "./bitwarden-worker-assets.mjs";
import { workerRealmSource } from "./lib/capability-graph.mjs";
import { sharedWorkerGraph } from "./shared-worker-graph.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const owner = join(
  repo,
  "packages/app-core/src/lib/secret-backends/bitwarden-wasm-loader.ts",
);
const require = createRequire(owner);
const zod = require.resolve("zod").replace(/index\.cjs$/, "index.js");
const root = await mkdtemp(join(tmpdir(), "opensesame-bws-graph-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const plan = {
  owner,
  specifier: "./bitwarden-secrets.worker.ts",
  name: "bitwarden-secrets.worker",
};
const sdk = bitwardenWorkerAssets([plan]);
const wasm = require.resolve("@bitwarden/sdk-wasm/bitwarden_wasm_bg.wasm");
const glue = require.resolve("@bitwarden/sdk-wasm/bitwarden_wasm_bg.js");
let sequence = 0;
async function fixture(shared) {
  const input = join(root, `host-${sequence++}.ts`);
  await writeFile(
    input,
    `import {z} from ${JSON.stringify(zod)};
import {createBrowserBitwardenClient} from ${JSON.stringify(owner)};
globalThis.hostOnly=z.object({id:z.string()}).strict();
globalThis.createClient=createBrowserBitwardenClient;`,
  );
  let bundle;
  await build({
    configFile: false,
    root: repo,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      ...(shared ? [sharedWorkerGraph({ workers: [plan] })] : []),
      {
        name: "capture-bws-fixture",
        generateBundle(_options, output) {
          bundle = output;
        },
      },
    ],
    resolve: {
      alias: {
        "@opensesame/os-domain": join(
          repo,
          "packages/os-domain/src/browser.ts",
        ),
      },
    },
    worker: { format: "es" },
    build: {
      write: false,
      target: "es2022",
      minify: "terser",
      terserOptions: {
        compress: { passes: 4, pure_getters: true, ecma: 2022 },
        format: { comments: false, ecma: 2022 },
        mangle: { toplevel: true },
      },
      rollupOptions: {
        input,
        output: {
          format: "es",
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          onlyExplicitManualChunks: true,
        },
      },
    },
  });
  return bundle;
}
function measure(bundle) {
  let raw = 0;
  let gzip = 0;
  for (const output of Object.values(bundle)) {
    if (!output.fileName.endsWith(".js")) continue;
    const bytes = Buffer.from(
      output.type === "chunk" ? output.code : output.source,
    );
    raw += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
  }
  return { raw, gzip };
}

test("real BWS worker shares pure Zod while preserving private SDK state and every emitted dependency", async () => {
  const baseline = await fixture(false);
  const candidate = await fixture(true);
  const before = measure(baseline);
  const after = measure(candidate);
  const values = Object.values(candidate);
  const worker = values.find(
    (value) => value.opensesameWorkerChunk?.name === plan.name,
  );
  assert.ok(worker, "BWS must be a registered isolated worker");
  const workerModules = Object.keys(worker.opensesameWorkerChunk.modules).map(
    workerRealmSource,
  );
  assert.ok(workerModules.includes(glue));
  assert.ok(workerModules.includes(wasm));
  assert.ok(!workerModules.includes(owner));
  const host = values.find(
    (value) => value.type === "chunk" && owner in value.modules,
  );
  const pure = values.filter(
    (value) =>
      value.type === "chunk" &&
      Object.keys(value.modules).some((id) =>
        id.includes("/node_modules/zod/"),
      ),
  );
  assert.equal(
    pure.length,
    1,
    "the worker and host must share one pure Zod chunk",
  );
  assert.ok(host.viteMetadata.importedAssets.has(worker.fileName));
  assert.ok(host.viteMetadata.importedAssets.has(pure[0].fileName));
  const raw = values.find(
    (value) => value.type === "asset" && value.fileName.endsWith(".wasm"),
  );
  assert.ok(raw && host.viteMetadata.importedAssets.has(raw.fileName));
  assert.deepEqual(Buffer.from(raw.source), await readFile(wasm));
  for (const dependency of host.viteMetadata.importedAssets)
    assert.ok(candidate[dependency]);
  assert.ok(
    before.gzip - after.gzip >= 12 * 1024,
    `actual gzip saving too small: ${JSON.stringify({ before, after })}`,
  );
  assert.ok(before.raw > after.raw);
  await writeFile(
    join(root, "measurement.json"),
    JSON.stringify({
      before,
      after,
      savedRaw: before.raw - after.raw,
      savedGzip: before.gzip - after.gzip,
    }),
  );
  console.log(
    "BWS_REAL_WORKER_MEASUREMENT",
    JSON.stringify({
      before,
      after,
      savedRaw: before.raw - after.raw,
      savedGzip: before.gzip - after.gzip,
    }),
  );
});

test("BWS admits only exact pinned glue/WASM within its own original realm", () => {
  for (const file of [glue, wasm]) {
    assert.equal(sdk.owns(file, plan.name), true);
    assert.equal(sdk.owns(file, "onepassword-sdk.worker"), false);
    assert.equal(sdk.owns(file, "tailscale-node"), false);
  }
  for (const file of [
    owner,
    glue.replace("bitwarden_wasm_bg.js", "index.js"),
    glue.replace("bitwarden_wasm_bg.js", "node/bitwarden_wasm.js"),
    `${wasm}?url`,
    `${wasm}.js`,
  ])
    assert.equal(sdk.owns(file, plan.name), false);
  assert.equal(sdk.resolve(`${wasm}?url`, plan.name), wasm);
  assert.equal(
    sdk.resolve(`${wasm}?url`, "onepassword-sdk.worker"),
    `${wasm}?url`,
  );
  assert.equal(sdk.resolve(`${wasm}?raw`, plan.name), `${wasm}?raw`);
});

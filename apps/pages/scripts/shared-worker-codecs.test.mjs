import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { afterAll, it as test } from "vitest";
import { workerRealmSource } from "./lib/capability-graph.mjs";
import {
  assertIsolatedCodecs,
  codecFixture,
} from "./shared-worker-codecs.test-support.mjs";
import { sharedWorkerGraph } from "./shared-worker-graph.mjs";
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const core = join(repo, "packages/app-core/src/lib");
const bytesFile = join(repo, "packages/vault-core/src/bytes.ts");
const backend = (name) => join(core, `secret-backends/${name}.ts`);
const closed = [
  bytesFile,
  join(core, "zod-jitless.ts"),
  ...[
    "wasm-gzip-asset",
    "bitwarden-worker-protocol",
    "bitwarden-native-worker-protocol",
    "bitwarden-native-contract",
    "bitwarden-native-network-protocol",
  ].map(backend),
];
const imports = `import {bytesToB64,b64ToBytes} from ${JSON.stringify(bytesFile)};
import {createGzipWasmAssetFetch} from ${JSON.stringify(backend("wasm-gzip-asset"))};
import {BitwardenCommandSchema} from ${JSON.stringify(backend("bitwarden-worker-protocol"))};
import {NativeWorkerRequest} from ${JSON.stringify(backend("bitwarden-native-worker-protocol"))};
import {NativeFetchRequest} from ${JSON.stringify(backend("bitwarden-native-network-protocol"))};
import {bitwardenNativeCapabilities} from ${JSON.stringify(backend("bitwarden-native-contract"))};
globalThis.codecFns={bytesToB64,b64ToBytes,createGzipWasmAssetFetch,BitwardenCommandSchema,NativeWorkerRequest,NativeFetchRequest,bitwardenNativeCapabilities};
(${codecFixture.toString()})(globalThis.codecFns);`;
const dir = await mkdtemp(join(tmpdir(), "opensesame-closed-codecs-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
let sequence = 0;
async function fixture({
  extra = "",
  corrupt = "",
  excluded = false,
  tailscale = false,
} = {}) {
  const work = join(dir, String(sequence++));
  const source = join(
    work,
    tailscale
      ? "apps/pages/src/modules/networking.tailnet/browser"
      : "packages/app-core/src/lib/secret-backends",
  );
  await mkdir(source, { recursive: true });
  const host = join(work, "host.ts");
  const workers = (
    tailscale
      ? ["tailscale-node"]
      : ["bitwarden-native.worker", "onepassword-sdk.worker"]
  ).map((name) => ({
    owner: join(source, tailscale ? "controller.ts" : `${name}-owner.ts`),
    specifier: tailscale ? "./worker.ts" : `./${name}.ts`,
    name,
  }));
  for (const worker of workers) {
    await writeFile(
      worker.owner,
      `export const start=()=>new Worker(new URL(${JSON.stringify(worker.specifier)},import.meta.url),{type:'module'});`,
    );
    await writeFile(
      join(dirname(worker.owner), worker.specifier),
      `${imports}\nglobalThis.workerOnly=true;${extra}`,
    );
  }
  await writeFile(
    host,
    excluded
      ? "globalThis.plain=true;"
      : `${imports}
${workers.map((worker, i) => `import * as owner${i} from ${JSON.stringify(worker.owner)};`).join("\n")}
globalThis.owners=[owner0,owner1];globalThis.hostOnly=true;`,
  );
  let bundle;
  await build({
    configFile: false,
    root: repo,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      sharedWorkerGraph({ workers }),
      {
        name: "closed-leaf-negative",
        enforce: "pre",
        transform(code, id) {
          if (corrupt && id === bytesFile) return code + corrupt;
        },
      },
      {
        name: "capture-codecs",
        generateBundle(_options, output) {
          bundle = output;
        },
      },
    ],
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
        input: host,
        output: {
          format: "es",
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          onlyExplicitManualChunks: true,
          experimentalMinChunkSize: 32000,
          manualChunks: (id) =>
            id === host || closed.includes(id)
              ? "host-contamination"
              : undefined,
        },
      },
    },
  });
  return { bundle, host, workers, work };
}
function closureProof(bundle, host, workers) {
  const values = Object.values(bundle);
  const shared = values.filter(
    (row) => row.type === "chunk" && closed.some((file) => file in row.modules),
  );
  for (const file of closed) {
    assert.equal(
      shared.filter((row) => file in row.modules).length,
      1,
      `Exact source emitted once: ${file}`,
    );
  }
  assert.ok(shared.every((row) => !(host in row.modules)));
  const roots = workers.map((plan) =>
    values.find(
      (row) =>
        row.type === "asset" && row.fileName.startsWith(`assets/${plan.name}-`),
    ),
  );
  for (const [index, root] of roots.entries()) {
    assert.ok(root.opensesameWorkerChunk);
    assert.ok(
      !Object.keys(root.opensesameWorkerChunk.modules).some((id) =>
        closed.includes(workerRealmSource(id)),
      ),
    );
    for (const row of shared)
      assert.ok(root.opensesameWorkerChunk.imports.includes(row.fileName));
    const owner = values.find(
      (row) => row.type === "chunk" && workers[index].owner in row.modules,
    );
    assert.ok(owner.viteMetadata.importedAssets.has(root.fileName));
    for (const row of shared)
      assert.ok(owner.viteMetadata.importedAssets.has(row.fileName));
    for (const file of owner.viteMetadata.importedAssets)
      assert.ok(bundle[file]);
  }
  const entry = values.find((row) => row.type === "chunk" && row.isEntry);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of bundle[file].imports ?? []) visit(next);
  };
  visit(entry.fileName);
  assert.ok(shared.every((row) => seen.has(row.fileName)));
  return { values, entry, roots };
}
test("closed source bytes execute independently in host and two jitless Worker realms", async () => {
  const { bundle, host, workers, work } = await fixture();
  const { values, entry, roots } = closureProof(bundle, host, workers);
  const raw = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const wire = gzipSync(raw, { level: 9 });
  const pin = (bytes) => ({
    bytes: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
  });
  await assertIsolatedCodecs(values, [entry, ...roots], work, {
    wire: [...wire],
    compressed: pin(wire),
    raw: pin(raw),
  });
});
test("excluded owners emit no codecs or Worker closure", async () => {
  const { bundle } = await fixture({ excluded: true });
  assert.equal(Object.keys(bundle).length, 1);
  const only = Object.values(bundle)[0];
  assert.equal(only.type, "chunk");
  assert.ok(!Object.keys(only.modules).some((id) => closed.includes(id)));
});
test.each(["nodeport", "hostDOM"])(
  "closed codec refuses new unreviewed runtime import: %s",
  async (kind) => {
    const target =
      kind === "nodeport"
        ? join(core, "tailscale/browser-node-port.ts")
        : join(dir, "host-dom.js");
    if (kind === "hostDOM")
      await writeFile(target, "globalThis.hostOnly=document.documentElement;");
    await assert.rejects(
      fixture({ corrupt: `\nimport ${JSON.stringify(target)};` }),
      /Closed Worker codec imports unreviewed source/,
    );
  },
);
test("same closed filename outside the owning workspace stays private", async () => {
  const file = join(dir, "foreign/packages/vault-core/src/bytes.ts");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "export const foreignCodec=7;");
  const { bundle } = await fixture({
    extra: `import {foreignCodec} from ${JSON.stringify(file)};globalThis.foreignCodec=foreignCodec;`,
  });
  assert.ok(
    Object.values(bundle)
      .filter((row) => row.type === "asset" && row.opensesameWorkerChunk)
      .some((row) =>
        Object.keys(row.opensesameWorkerChunk.modules).some(
          (id) => workerRealmSource(id) === file,
        ),
      ),
  );
  assert.ok(
    !Object.values(bundle).some(
      (row) => row.type === "chunk" && file in row.modules,
    ),
  );
});

test("password codecs retain their original exclusion from the tailnet realm", async () => {
  await assert.rejects(
    fixture({ tailscale: true }),
    /Closed Worker codec is outside its original realm authority/,
  );
});

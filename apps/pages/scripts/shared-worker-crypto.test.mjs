import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, it as test } from "vitest";
import { workerRealmSource } from "./lib/capability-graph.mjs";
import { sharedWorkerGraph } from "./shared-worker-graph.mjs";
import { assertIsolatedCrypto } from "./shared-worker-graph.test-support.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const core = join(repo, "packages/app-core");
const require = createRequire(join(core, "package.json"));
const hash = await realpath(
  require.resolve("hash-wasm").replace("index.umd.js", "index.esm.js"),
);
const cbor = await realpath(
  join(dirname(require.resolve("@levischuck/tiny-cbor")), "../esm/index.js"),
);
const { argon2dAsync } = await import(
  pathToFileURL(require.resolve("@noble/hashes/argon2.js")).href
);
const dir = await mkdtemp(join(tmpdir(), "opensesame-shared-crypto-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
let sequence = 0;
async function fixture({ extra = "", excluded = false } = {}) {
  const work = join(dir, String(sequence++));
  const backend = join(work, "packages/app-core/src/lib/secret-backends");
  await mkdir(backend, { recursive: true });
  const host = join(work, "host.ts");
  const workers = ["bitwarden-native.worker", "onepassword-sdk.worker"].map(
    (name) => ({
      owner: join(backend, `${name}-owner.ts`),
      specifier: `./${name}.ts`,
      name,
    }),
  );
  const imports = `import {zodJitless} from ${JSON.stringify(join(core, "src/lib/zod-jitless.ts"))};
zodJitless();
import {argon2d,argon2id} from ${JSON.stringify(hash)};
import {CBORTag,encodeCBOR,decodeCBOR} from ${JSON.stringify(cbor)};`;
  const checks = `globalThis.cborFixture=()=>{
const bytes=encodeCBOR(new Map([[1,new Uint8Array([7,8])],[2,new CBORTag(24,"x")]]));
const decoded=decodeCBOR(bytes);return {hex:[...bytes].map(v=>v.toString(16).padStart(2,"0")).join(""),tag:decoded.get(2).tag,value:decoded.get(2).value};};
globalThis.cborInvalid=()=>decodeCBOR(new Uint8Array([0x18]));`;
  for (const plan of workers) {
    await writeFile(
      plan.owner,
      `export const start=()=>new Worker(new URL(${JSON.stringify(plan.specifier)},import.meta.url),{type:'module'});`,
    );
    await writeFile(
      join(backend, `${plan.name}.ts`),
      `${imports}
import {deriveBitwardenMasterKey} from ${JSON.stringify(join(core, "src/lib/secret-backends/bitwarden-native-kdf.ts"))};
globalThis.cryptoFns={argon2d,argon2id,CBORTag,encodeCBOR,decodeCBOR};
globalThis.derive=parallelism=>deriveBitwardenMasterKey("  Pässe\u0301🔐  ",new Uint8Array(new TextEncoder().encode(" Mixed.Case+salt@Example.test ")),{kdfType:1,iterations:2,memoryMiB:16,parallelism},{maxPbkdf2Iterations:6000,maxArgon2Iterations:2,maxArgon2MemoryMiB:16,maxArgon2Parallelism:2});
${checks}
globalThis.realmName=${JSON.stringify(plan.name)};
${extra}`,
    );
  }
  await writeFile(
    host,
    excluded
      ? "globalThis.plain=true;"
      : `${imports}
import {cappedArgon2Impl} from ${JSON.stringify(join(core, "src/lib/vault/import/formats/kdbx-argon2.ts"))};
${workers.map((plan, i) => `import * as owner${i} from ${JSON.stringify(plan.owner)};`).join("\n")}
globalThis.owners=[owner0,owner1];globalThis.hostOnly='host';
globalThis.cryptoFns={argon2d,argon2id,CBORTag,encodeCBOR,decodeCBOR};
const kdbx=cappedArgon2Impl({argon2d,argon2id},2);
globalThis.kdbx=(salt,type=0,version=0x13)=>kdbx(new TextEncoder().encode("  Pässe\u0301🔐  ").buffer,new Uint8Array(salt).buffer,16384,2,32,1,type,version);
${checks}`,
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
        name: "capture-shared-crypto",
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
            id === host ||
            /\/node_modules\/(?:hash-wasm|@levischuck\/tiny-cbor)\//.test(id)
              ? "host-contamination"
              : undefined,
        },
      },
    },
  });
  return { bundle, host, workers, work };
}

test("same installed crypto bytes serve host and isolated Workers without sharing realm state", async () => {
  const { bundle, host, workers, work } = await fixture();
  const values = Object.values(bundle);
  const shared = values.filter(
    (row) =>
      row.type === "chunk" &&
      Object.keys(row.modules).some(
        (id) => id === hash || id.startsWith(`${dirname(cbor)}/`),
      ),
  );
  const hashChunks = shared.filter((row) => hash in row.modules);
  assert.equal(
    hashChunks.length,
    1,
    "hash-wasm must not be virtualized into each Worker",
  );
  assert.ok(
    shared.some((row) =>
      Object.keys(row.modules).some((id) => id.endsWith("/cbor/cbor.js")),
    ),
  );
  assert.ok(
    shared.every((row) => !(host in row.modules)),
    "pure partitions retain the host contamination guard",
  );
  const hostChunk = values.find(
    (row) => row.type === "chunk" && host in row.modules,
  );
  const roots = workers.map((plan) =>
    values.find(
      (row) =>
        row.type === "asset" && row.fileName.startsWith(`assets/${plan.name}-`),
    ),
  );
  for (const [index, root] of roots.entries()) {
    assert.ok(root?.opensesameWorkerChunk);
    const ids = Object.keys(root.opensesameWorkerChunk.modules);
    assert.ok(
      !ids.some((id) =>
        /hash-wasm|tiny-cbor/.test(workerRealmSource(id) ?? id),
      ),
      "dependency code must appear once in real classified chunks",
    );
    assert.ok(
      root.opensesameWorkerChunk.imports.includes(hashChunks[0].fileName),
    );
    const owner = values.find(
      (row) => row.type === "chunk" && workers[index].owner in row.modules,
    );
    assert.ok(owner, "original worker owner must remain in emitted graph");
    assert.ok(owner.viteMetadata.importedAssets.has(root.fileName));
    for (const row of shared)
      assert.ok(owner.viteMetadata.importedAssets.has(row.fileName));
    for (const file of owner.viteMetadata.importedAssets)
      assert.ok(bundle[file], file);
  }
  const entry = values.find((row) => row.type === "chunk" && row.isEntry);
  const reachable = new Set();
  const visit = (file) => {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const next of bundle[file].imports ?? []) visit(next);
  };
  visit(entry.fileName);
  assert.ok(reachable.has(hostChunk.fileName));
  for (const row of shared) assert.ok(reachable.has(row.fileName));
  const salt = createHash("sha256")
    .update(" Mixed.Case+salt@Example.test ")
    .digest();
  const d = await argon2dAsync(Buffer.from("  Pässe\u0301🔐  "), salt, {
    m: 16384,
    t: 2,
    p: 1,
    version: 19,
    dkLen: 32,
    maxmem: 32 * 1024 * 1024,
  });
  await assertIsolatedCrypto(values, [entry, ...roots], work, {
    salt: [...salt],
    argon2d: Buffer.from(d).toString("hex"),
  });
});

test("excluded crypto owners emit no Worker or optional dependency closure", async () => {
  const { bundle } = await fixture({ excluded: true });
  assert.equal(Object.keys(bundle).length, 1);
  const only = Object.values(bundle)[0];
  assert.equal(only.type, "chunk");
  assert.ok(
    !Object.keys(only.modules).some((id) =>
      /hash-wasm|tiny-cbor|secret-backends/.test(id),
    ),
  );
});

test.each(["hash-wasm-sibling", "@levischuck/tiny-cbor-sibling"])(
  "similarly named package is not admitted as shared crypto: %s",
  async (name) => {
    const file = join(dir, "node_modules", name, "index.js");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "globalThis.unowned=document.documentElement;");
    await assert.rejects(
      fixture({ extra: `import ${JSON.stringify(file)};` }),
      /Worker import crosses its private runtime boundary/,
    );
  },
);

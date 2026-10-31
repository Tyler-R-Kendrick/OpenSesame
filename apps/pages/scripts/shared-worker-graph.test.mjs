import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, it as test } from "vitest";
import {
  ONEPASSWORD_ASSETS,
  attachOnePasswordAssets,
} from "./onepassword-wasm-assets.mjs";
import { sharedWorkerGraph } from "./shared-worker-graph.mjs";
import { assertIsolatedParsers } from "./shared-worker-graph.test-support.mjs";
import {
  TAILSCALE_ASSETS,
  attachTailscaleAssets,
} from "./tailscale-wasm-assets.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const appRequire = createRequire(join(repo, "packages/app-core/package.json"));
const pageRequire = createRequire(join(repo, "apps/pages/package.json"));
const coreZod = appRequire.resolve("zod").replace(/index\.cjs$/, "index.js");
const pageZod = pageRequire
  .resolve("zod")
  .replace("/dist/commonjs/", "/dist/esm/")
  .replace(/index\.cjs$/, "index.js");
const dir = await mkdtemp(join(tmpdir(), "opensesame-worker-graph-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const sdk = join(
  dir,
  "packages/app-core/src/lib/secret-backends/onepassword-sdk-loader.ts",
);
const controller = join(
  dir,
  "src/modules/networking.tailnet/browser/controller.ts",
);
const host = join(dir, "host.ts");
const workers = [
  {
    owner: sdk,
    specifier: "./onepassword-sdk.worker.ts",
    name: "onepassword-sdk.worker",
  },
  { owner: controller, specifier: "./worker.ts", name: "tailscale-node" },
];
for (const file of [sdk, controller])
  await mkdir(dirname(file), { recursive: true });
await writeFile(
  sdk,
  `import {z} from ${JSON.stringify(coreZod)}; z.config({jitless:true});
export const check = v => z.object({id:z.number().int().positive()}).strict().safeParse(v).success;
export const start = () => new Worker(new URL("./onepassword-sdk.worker.ts",import.meta.url),{type:"module",name:"original-sdk"});`,
);
await writeFile(
  controller,
  `import {z} from ${JSON.stringify(pageZod)}; z.config({jitless:true});
export const check = v => z.object({id:z.number().int().positive()}).strict().safeParse(v).success;
export const start = () => new Worker(new URL("./worker.ts",import.meta.url),{type:"module",name:"original-tailnet"});`,
);
for (const [index, plan] of workers.entries()) {
  await writeFile(
    resolve(dirname(plan.owner), plan.specifier),
    `import {z} from ${JSON.stringify(index === 0 ? coreZod : pageZod)};
z.config({jitless:true});
const schema = z.object({id:z.number().int().positive()}).strict();
globalThis.onmessage = value => schema.safeParse(value).success;
globalThis.workerRealm = ${JSON.stringify(plan.name)};`,
  );
}
await writeFile(
  host,
  `import * as sdk from ${JSON.stringify(sdk)};import * as tailnet from ${JSON.stringify(controller)};
globalThis.hostOnly = "host-private"; globalThis.owners = [sdk,tailnet];`,
);
const classify = (id) => ({
  classification: "optional",
  capability: "connectors.external",
  id,
});

async function fixture({
  input = host,
  extra = [],
  manualChunks,
  attach = true,
  originalPartition = false,
  plans = workers,
} = {}) {
  let bundle;
  const workerPlugin = sharedWorkerGraph({ workers: plans });
  if (originalPartition) workerPlugin.outputOptions = undefined;
  const result = await build({
    configFile: false,
    root: dir,
    cacheDir: join(dir, "cache"),
    publicDir: false,
    logLevel: "silent",
    plugins: [
      workerPlugin,
      ...extra,
      {
        name: "original-native-asset-guards",
        generateBundle(_options, output) {
          if (attach) {
            assert.equal(attachOnePasswordAssets(output, classify), true);
            attachTailscaleAssets(output);
            for (const fileName of [
              ...Object.values(ONEPASSWORD_ASSETS),
              ...Object.values(TAILSCALE_ASSETS),
            ])
              this.emitFile({
                type: "asset",
                fileName,
                source: "owned test asset",
              });
          }
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
        input,
        output: {
          format: "es",
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          experimentalMinChunkSize: 32000,
          onlyExplicitManualChunks: true,
          manualChunks:
            manualChunks ??
            ((id) =>
              id === sdk
                ? "sdk-owner"
                : id === controller
                  ? "tailnet-owner"
                  : undefined),
        },
      },
    },
  });
  return { bundle, output: result.output };
}

test("module workers retain original owners, patched Zod, pure versions, and complete offline closures", async () => {
  const { bundle } = await fixture();
  const values = Object.values(bundle);
  const sdkOwner = values.find((v) => v.type === "chunk" && sdk in v.modules);
  const tailnetOwner = values.find(
    (v) => v.type === "chunk" && controller in v.modules,
  );
  const roots = workers.map((plan) =>
    values.find(
      (v) =>
        v.type === "asset" && v.fileName.startsWith(`assets/${plan.name}-`),
    ),
  );
  assert.ok(roots.every(Boolean));
  assert.equal(roots.length, 2);
  for (const root of roots) {
    assert.equal(root.opensesameWorkerChunk.code, root.source);
    assert.ok(
      Object.keys(root.opensesameWorkerChunk.modules).some((id) =>
        id.startsWith("\0opensesame-worker:"),
      ),
    );
  }
  const pureChunks = values.filter(
    (v) =>
      v.type === "chunk" &&
      Object.keys(v.modules).some((id) => id.includes("/node_modules/zod/")),
  );
  assert.ok(pureChunks.length > 0);
  const ids = pureChunks.flatMap((v) => Object.keys(v.modules));
  const zodIds = ids.filter((id) => id.includes("/node_modules/zod/"));
  assert.ok(zodIds.length > 0);
  assert.ok(zodIds.every((id) => id.includes("zod@4.6.6/")));
  assert.ok(!ids.some((id) => id.includes("zod@3.")));
  assert.ok(!zodIds.some((id) => id.includes("/node_modules/zod/v3/")));
  for (const [i, owner] of [sdkOwner, tailnetOwner].entries()) {
    const refs = owner.viteMetadata.importedAssets;
    assert.ok(refs.has(roots[i].fileName));
    assert.ok(pureChunks.some((v) => refs.has(v.fileName)));
    for (const file of refs)
      assert.ok(bundle[file], `missing offline asset: ${file}`);
    const native = i === 0 ? ONEPASSWORD_ASSETS : TAILSCALE_ASSETS;
    for (const file of Object.values(native)) assert.ok(refs.has(file));
    assert.match(owner.code, /type:\s*["']module["']/);
    assert.match(owner.code, i === 0 ? /original-sdk/ : /original-tailnet/);
  }
  const outputs = new Map(
    values.map((v) => [v.fileName, v.type === "chunk" ? v.code : v.source]),
  );
  await assertIsolatedParsers(outputs, roots, dir);
});

test("excluded owners do not emit worker entries or native assets", async () => {
  const plain = join(dir, "plain.ts");
  await writeFile(plain, "globalThis.plain = true;");
  const { output } = await fixture({ input: plain, attach: false });
  assert.equal(output.length, 1);
  assert.ok(!output.some((item) => item.type === "asset"));
});

test("partition prevents the reproduced full-app host contamination and preserves delegation", async () => {
  const delegated = new Set();
  const manualChunks = (id, api) => {
    assert.ok(api.getModuleInfo);
    delegated.add(id);
    return id === sdk
      ? "sdk-owner"
      : id === controller
        ? "tailnet-owner"
        : id === host || id.includes("/node_modules/zod/")
          ? "unsafe-host-mix"
          : undefined;
  };
  // Remove only the new hook to reproduce the original full-app failure mechanism.
  await assert.rejects(
    fixture({ manualChunks, originalPartition: true }),
    (error) => {
      assert.match(
        error.message,
        /Worker closure unexpectedly includes host modules: assets\/host-[A-Za-z0-9_-]+\.js;/,
      );
      assert.ok(error.message.includes(host));
      return true;
    },
  );
  const { bundle } = await fixture({ manualChunks });
  assert.ok(
    delegated.has(host) && delegated.has(sdk) && delegated.has(controller),
  );
  assert.ok(
    Object.values(bundle).some(
      (item) => item.type === "chunk" && item.name === "sdk-owner",
    ),
  );
  assert.ok(
    Object.values(bundle).some(
      (item) => item.type === "chunk" && item.name === "tailnet-owner",
    ),
  );
});

test("pure partitions still reject a real host module inside a private worker chunk", async () => {
  await assert.rejects(
    fixture({
      attach: false,
      manualChunks: (id) =>
        id === host ||
        id.startsWith("\0opensesame-worker:onepassword-sdk.worker:")
          ? "illegal-worker-host-mix"
          : undefined,
    }),
    (error) => {
      assert.match(
        error.message,
        /Worker-private chunk unexpectedly contains host\/shared modules: assets\/onepassword-sdk\.worker-[A-Za-z0-9_-]+\.js;/,
      );
      assert.ok(error.message.includes(host));
      return true;
    },
  );
});

async function rejectWorkerImport(prefix, expected) {
  const file = resolve(dirname(sdk), workers[0].specifier);
  const original = await readFile(file, "utf8");
  try {
    await writeFile(file, `${prefix}\n${original}`);
    await assert.rejects(fixture({ attach: false }), expected);
  } finally {
    await writeFile(file, original);
  }
}

test("unresolved external worker dependencies fail instead of escaping dist", async () => {
  await rejectWorkerImport(
    'import "https://unowned.invalid/module.js";',
    /Unresolved private worker import/,
  );
});

test("a direct host DOM/runtime import is rejected before worker emission", async () => {
  const hostDOM = join(dir, "host-dom.ts");
  await writeFile(
    hostDOM,
    "export const hostDocument = document.documentElement;",
  );
  await rejectWorkerImport(
    `import {hostDocument} from ${JSON.stringify(hostDOM)}; globalThis.leak=hostDocument;`,
    /Worker import crosses its private runtime boundary/,
  );
});

test.each([
  [{ ...workers[1], name: workers[0].name }],
  [{ ...workers[1], owner: workers[0].owner }],
  [{ ...workers[1], additionalOwners: [workers[1].owner] }],
])(
  "duplicate worker identities or original owners fail closed",
  (duplicate) => {
    const plugin = sharedWorkerGraph({ workers: [workers[0], duplicate] });
    assert.throws(
      () => plugin.configResolved({ root: dir }),
      /unique names and original owners/,
    );
  },
);

test.each([
  ["onepassword-sdk.worker", "/forbidden/host-dom.ts"],
  [
    "onepassword-sdk.worker",
    "/repo/packages/app-core/src/lib/secret-backends/../../host-dom.ts",
  ],
  [
    "unknown-realm",
    "/repo/packages/app-core/src/lib/secret-backends/native.ts",
  ],
])("forged worker realm imports fail closed: %s %s", async (realm, path) => {
  const forged = `\0opensesame-worker:${realm}:${Buffer.from(path).toString("base64url")}.ts`;
  await rejectWorkerImport(
    `import ${JSON.stringify(forged)};`,
    /Unowned worker realm module ID/,
  );
});

test("an explicit identity owner shares only the original Tailscale entry and offline closure", async () => {
  const identity = join(dirname(controller), "identity-browser-node.ts");
  await writeFile(
    identity,
    'export const start = () => new Worker(new URL("./worker.ts",import.meta.url),{type:"module",name:"identity-only"});',
  );
  const input = join(dir, "identity-host.ts");
  await writeFile(
    input,
    `import * as sdk from ${JSON.stringify(sdk)};import * as tailnet from ${JSON.stringify(controller)};import * as identity from ${JSON.stringify(identity)};globalThis.owners=[sdk,tailnet,identity];`,
  );
  const { bundle } = await fixture({
    input,
    plans: [workers[0], { ...workers[1], additionalOwners: [identity] }],
    manualChunks: (id) =>
      id === sdk
        ? "sdk-owner"
        : id === controller
          ? "tailnet-owner"
          : id === identity
            ? "identity-owner"
            : undefined,
  });
  const values = Object.values(bundle);
  const roots = values.filter(
    (value) =>
      value.type === "asset" &&
      value.fileName.startsWith("assets/tailscale-node-"),
  );
  assert.equal(roots.length, 1);
  for (const source of [controller, identity]) {
    const owner = values.find(
      (value) => value.type === "chunk" && source in value.modules,
    );
    assert.ok(owner);
    assert.ok(owner.viteMetadata.importedAssets.has(roots[0].fileName));
    for (const file of owner.viteMetadata.importedAssets)
      assert.ok(bundle[file]);
  }
  assert.ok(
    !Object.keys(roots[0].opensesameWorkerChunk.modules).some(
      (id) => id === controller || id === identity,
    ),
  );
});

test("an owner alias cannot redirect the original relative Worker entry", () => {
  const plugin = sharedWorkerGraph({
    workers: [
      {
        ...workers[1],
        additionalOwners: [join(dir, "foreign/identity-browser-node.ts")],
      },
    ],
  });
  assert.throws(() => plugin.configResolved({ root: dir }), /original entry/);
});

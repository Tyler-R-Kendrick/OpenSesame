import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
import {
  TAILSCALE_ASSETS,
  attachTailscaleAssets,
} from "./tailscale-wasm-assets.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const appRequire = createRequire(join(repo, "packages/app-core/package.json"));
const pageRequire = createRequire(join(repo, "apps/pages/package.json"));
const z4 = appRequire.resolve("zod").replace(/index\.cjs$/, "index.js");
const z3 = pageRequire
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
  `import {z} from ${JSON.stringify(z4)}; z.config({jitless:true});
export const check = v => z.object({id:z.number().int().positive()}).strict().safeParse(v).success;
export const start = () => new Worker(new URL("./onepassword-sdk.worker.ts",import.meta.url),{type:"module",name:"original-sdk"});`,
);
await writeFile(
  controller,
  `import {z} from ${JSON.stringify(z3)};
export const check = v => z.object({id:z.number().int().positive()}).strict().safeParse(v).success;
export const start = () => new Worker(new URL("./worker.ts",import.meta.url),{type:"module",name:"original-tailnet"});`,
);
for (const [index, plan] of workers.entries()) {
  await writeFile(
    resolve(dirname(plan.owner), plan.specifier),
    `import {z} from ${JSON.stringify(index === 0 ? z4 : z3)};
${index === 0 ? "z.config({jitless:true});" : ""}
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
} = {}) {
  let bundle;
  const result = await build({
    configFile: false,
    root: dir,
    cacheDir: join(dir, "cache"),
    publicDir: false,
    logLevel: "silent",
    plugins: [
      sharedWorkerGraph({ workers }),
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

async function assertIsolatedParsers(outputs, roots) {
  const runner = `
import assert from "node:assert/strict";
import {createContext, SourceTextModule} from "node:vm";
import {readFile} from "node:fs/promises";
const {outputs,roots} = JSON.parse(await readFile(process.argv[1],"utf8"));
for (const entry of roots) {
 const context=createContext({}, {codeGeneration:{strings:false,wasm:false}});
 const modules=new Map();
 const load=file=>{
  if(!modules.has(file)) modules.set(file,new SourceTextModule(outputs[file],{context,identifier:file}));
  return modules.get(file);
 };
 const module=load(entry);
 await module.link((specifier,parent)=>load(new URL(specifier,"file:///"+parent.identifier).pathname.slice(1)));
 await module.evaluate();
 assert.equal(context.hostOnly,undefined);
 assert.equal(context.onmessage({id:1}),true);
 for(const value of [{id:0},{id:1.5},{id:1,unknown:true},{id:"1"}]) assert.equal(context.onmessage(value),false);
}
process.stdout.write("isolated-strict-parsers-ok");`;
  const proofInput = join(dir, "realm-input.json");
  await writeFile(
    proofInput,
    JSON.stringify({
      outputs: Object.fromEntries(outputs),
      roots: roots.map((root) => root.fileName),
    }),
  );
  const stdoutFile = join(dir, "realm.stdout");
  const stderrFile = join(dir, "realm.stderr");
  const stdout = await open(stdoutFile, "wx", 0o600);
  const stderr = await open(stderrFile, "wx", 0o600);
  let exitCode;
  try {
    exitCode = await new Promise((accept, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-vm-modules",
          "--input-type=module",
          "-e",
          runner,
          proofInput,
        ],
        {
          stdio: ["ignore", stdout.fd, stderr.fd],
          signal: AbortSignal.timeout(5000),
        },
      );
      child.once("error", reject);
      child.once("close", accept);
    });
  } finally {
    await stdout.close();
    await stderr.close();
  }
  assert.equal(exitCode, 0, await readFile(stderrFile, "utf8"));
  assert.equal(
    await readFile(stdoutFile, "utf8"),
    "isolated-strict-parsers-ok",
  );
}

test("module workers retain original owners, pure versions, and complete offline closures", async () => {
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
  assert.ok(ids.some((id) => id.includes("zod@4.")));
  assert.ok(ids.some((id) => id.includes("zod@3.")));
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
  await assertIsolatedParsers(outputs, roots);
});

test("excluded owners do not emit worker entries or native assets", async () => {
  const plain = join(dir, "plain.ts");
  await writeFile(plain, "globalThis.plain = true;");
  const { output } = await fixture({ input: plain, attach: false });
  assert.equal(output.length, 1);
  assert.ok(!output.some((item) => item.type === "asset"));
});

test("host code cannot be merged into a worker's shared dependency closure", async () => {
  await assert.rejects(
    fixture({
      attach: false,
      manualChunks: (id) =>
        id === host || id.includes("/node_modules/zod/")
          ? "unsafe-host-mix"
          : undefined,
    }),
    /Worker closure unexpectedly includes host modules/,
  );
});

test("unresolved external worker dependencies fail instead of escaping dist", async () => {
  const badWorker = resolve(dirname(sdk), workers[0].specifier);
  const original = await readFile(badWorker, "utf8");
  try {
    await writeFile(
      badWorker,
      `import "https://unowned.invalid/module.js";\n${original}`,
    );
    await assert.rejects(
      fixture({ attach: false }),
      /Unresolved private worker import/,
    );
  } finally {
    await writeFile(badWorker, original);
  }
});

test("a direct host DOM/runtime import is rejected before worker emission", async () => {
  const badWorker = resolve(dirname(sdk), workers[0].specifier);
  const original = await readFile(badWorker, "utf8");
  const hostDOM = join(dir, "host-dom.ts");
  await writeFile(
    hostDOM,
    "export const hostDocument = document.documentElement;",
  );
  try {
    await writeFile(
      badWorker,
      `import {hostDocument} from ${JSON.stringify(hostDOM)}; globalThis.leak=hostDocument;\n${original}`,
    );
    await assert.rejects(
      fixture({ attach: false }),
      /Worker import crosses its private runtime boundary/,
    );
  } finally {
    await writeFile(badWorker, original);
  }
});

test.each([
  [{ ...workers[1], name: workers[0].name }],
  [{ ...workers[1], owner: workers[0].owner }],
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
  const file = resolve(dirname(sdk), workers[0].specifier);
  const original = await readFile(file, "utf8");
  const forged = `\0opensesame-worker:${realm}:${Buffer.from(path).toString("base64url")}.ts`;
  try {
    await writeFile(file, `import ${JSON.stringify(forged)};\n${original}`);
    await assert.rejects(
      fixture({ attach: false }),
      /Unowned worker realm module ID/,
    );
  } finally {
    await writeFile(file, original);
  }
});

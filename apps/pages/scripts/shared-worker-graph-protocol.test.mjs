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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, it as test } from "vitest";
import { workerRealmSource } from "./lib/capability-graph.mjs";
import { sharedWorkerGraph } from "./shared-worker-graph.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const core = join(repo, "packages/app-core/src/lib");
const protocol = join(
  repo,
  "apps/pages/src/modules/networking.tailnet/browser/protocol.ts",
);
const pageZod = createRequire(join(repo, "apps/pages/package.json"))
  .resolve("zod")
  .replace("/dist/commonjs/", "/dist/esm/")
  .replace(/index\.cjs$/, "index.js");
const coreZod = createRequire(join(repo, "packages/app-core/package.json"))
  .resolve("zod")
  .replace(/index\.cjs$/, "index.js");
const dir = await mkdtemp(join(tmpdir(), "opensesame-real-worker-protocol-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
let sequence = 0;
async function fixture({
  extraImport = "",
  realm = "tailscale-node",
  neighbor = "",
} = {}) {
  const work = join(dir, String(sequence++));
  const owner = join(work, "owner.ts");
  const worker =
    realm === "tailscale-node"
      ? join(work, "src/modules/networking.tailnet/browser/worker.ts")
      : join(
          work,
          "packages/app-core/src/lib/secret-backends/onepassword-sdk.worker.ts",
        );
  await mkdir(dirname(worker), { recursive: true });
  if (neighbor) {
    await writeFile(
      join(dirname(worker), neighbor),
      "globalThis.unownedPeerHelper = true;",
    );
    extraImport += `\nimport ${JSON.stringify(`./${neighbor}`)};`;
  }
  await writeFile(
    owner,
    `import {z as pageZod} from ${JSON.stringify(pageZod)};
import {z as coreZod} from ${JSON.stringify(coreZod)};
globalThis.hostOnly=[pageZod.string().parse('host'),coreZod.string().parse('host')];
export const start=()=>new Worker(new URL(${JSON.stringify(worker)},import.meta.url),{type:'module'});`,
  );
  const body =
    realm === "tailscale-node"
      ? `
import {zodJitless} from ${JSON.stringify(join(core, "zod-jitless.ts"))};
import {WorkerMessage,NativeHTTPConfiguration} from ${JSON.stringify(protocol)};
zodJitless();
globalThis.message=v=>WorkerMessage.safeParse(v).success;
globalThis.route=v=>NativeHTTPConfiguration.safeParse(v).success;`
      : "globalThis.workerRealm='password';";
  await writeFile(worker, `${extraImport}\n${body}`);
  const plugin = sharedWorkerGraph({
    workers: [{ owner, specifier: worker, name: realm }],
  });
  let bundle;
  await build({
    configFile: false,
    root: repo,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      plugin,
      {
        name: "capture-real-protocol",
        generateBundle(_options, output) {
          bundle = output;
        },
      },
    ],
    build: {
      write: false,
      target: "es2022",
      minify: false,
      rollupOptions: {
        input: owner,
        output: {
          format: "es",
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          onlyExplicitManualChunks: true,
          manualChunks: (id) =>
            id === owner || id.includes("/node_modules/zod/")
              ? "host-with-pure-dependencies"
              : undefined,
        },
      },
    },
  });
  return { bundle, owner, worker, work };
}
async function evaluateProtocol(bundle, root, work) {
  const outputs = Object.fromEntries(
    Object.values(bundle).map((value) => [
      value.fileName,
      value.type === "chunk" ? value.code : value.source,
    ]),
  );
  const input = join(work, "emitted.json");
  await writeFile(input, JSON.stringify({ outputs, root: root.fileName }));
  const runner = `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,SourceTextModule} from 'node:vm';
const {outputs,root}=JSON.parse(await readFile(process.argv[1],'utf8'));
const context=createContext({URL,TextEncoder,TextDecoder,atob,btoa},{codeGeneration:{strings:false,wasm:false}});
const modules=new Map();
const load=file=>{if(!modules.has(file))modules.set(file,new SourceTextModule(outputs[file],{context,identifier:file}));return modules.get(file)};
const entry=load(root);
await entry.link((source,parent)=>load(new URL(source,'file:///'+parent.identifier).pathname.slice(1)));
await entry.evaluate();
assert.equal(context.hostOnly,undefined);
if(context.streamRegistry) {
 const messages=[];
 const registry=new context.streamRegistry(()=>undefined,message=>messages.push(message));
 assert.equal(registry.receive({kind:"nativeHTTPReady"}),true);
 assert.equal(messages.length,1);
 assert.equal(messages[0].kind,"nativeHTTPReady");
 assert.equal(messages[0].ready,false);
 assert.equal(Object.keys(messages[0]).sort().join(","),"kind,ready");
 assert.equal(registry.close(),true);
 assert.equal(registry.closed,true);
}
assert.equal(context.__zod_globalConfig.jitless,true);
assert.equal(context.message({kind:'nativeHTTPReady'}),true);
assert.equal(context.message({kind:'cancelHTTP',id:0}),false);
const peer={routeMode:'peer',peerID:'n-original-peer',trustMode:'public',targets:[{origin:'https://byo.example.test',prefixes:['100.64.0.1/32']}]};
assert.equal(context.route(peer),true);
for(const bad of [{...peer,peerID:''},{...peer,exitNodeID:'fallback'},{...peer,unknown:true},{...peer,targets:[{origin:'https://byo.example.test/path',prefixes:['100.64.0.1/32']}]},{...peer,targets:[{origin:'https://byo.example.test',prefixes:['0.0.0.0/0']}]}])assert.equal(context.route(bad),false);
assert.equal(context.route({exitNodeID:'legacy-exit',trustMode:'public',targets:[{origin:'https://api.example.test',prefixes:['203.0.113.0/24']}]}),true);
process.stdout.write('real-shipped-protocol-csp-strict-ok');`;
  const stdoutFile = join(work, "realm.stdout");
  const stderrFile = join(work, "realm.stderr");
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
          input,
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
    "real-shipped-protocol-csp-strict-ok",
  );
}

test("real shipped peer protocol isolates patched Zod and exact public validation dependencies", async () => {
  const { bundle, owner, work } = await fixture();
  const values = Object.values(bundle);
  const root = values.find(
    (value) =>
      value.type === "asset" &&
      value.fileName.startsWith("assets/tailscale-node-"),
  );
  assert.ok(root?.opensesameWorkerChunk);
  const workerFiles = Object.keys(root.opensesameWorkerChunk.modules).map(
    workerRealmSource,
  );
  for (const file of [
    protocol,
    join(core, "tailscale/browser-node-peer-http.ts"),
    join(core, "tailscale/browser-node-port.ts"),
  ])
    assert.ok(workerFiles.includes(file), file);
  const ids = values.flatMap((value) =>
    Object.keys(value.modules ?? value.opensesameWorkerChunk?.modules ?? {}),
  );
  const zodIds = ids.filter((id) => id.includes("/node_modules/zod/"));
  assert.ok(zodIds.length > 0);
  assert.ok(zodIds.every((id) => id.includes("zod@4.6.6/")));
  assert.ok(!ids.some((id) => id.includes("zod@3.")));
  assert.ok(!zodIds.some((id) => id.includes("/node_modules/zod/v3/")));
  const host = values.find(
    (value) => value.type === "chunk" && owner in value.modules,
  );
  assert.ok(host.viteMetadata.importedAssets.has(root.fileName));
  for (const file of host.viteMetadata.importedAssets) assert.ok(bundle[file]);
  assert.ok(
    !workerFiles.some((file) => file?.endsWith("/browser-node-store.ts")),
  );
  await evaluateProtocol(bundle, root, work);
});

test.each(["tailscale/browser-node-store.ts", "kv.ts"])(
  "peer public validation does not admit other app-core runtime: %s",
  async (file) => {
    await assert.rejects(
      fixture({ extraImport: `import ${JSON.stringify(join(core, file))};` }),
      /Worker import crosses its private runtime boundary/,
    );
  },
);

test.each(["browser-node-peer-http.ts", "browser-node-port.ts"])(
  "peer public validation stays excluded from the password-worker realm: %s",
  async (file) => {
    await assert.rejects(
      fixture({
        realm: "onepassword-sdk.worker",
        extraImport: `import ${JSON.stringify(join(core, "tailscale", file))};`,
      }),
      /Worker import crosses its private runtime boundary/,
    );
  },
);

const streamRegistry = join(
  repo,
  "apps/pages/src/modules/networking.tailnet/browser/worker-native-http.ts",
);
test("shipped native stream registry stays in the isolated tailscale Worker graph", async () => {
  const { bundle, work } = await fixture({
    extraImport: `import {WorkerNativeHTTP} from ${JSON.stringify(streamRegistry)};globalThis.streamRegistry=WorkerNativeHTTP;`,
  });
  const root = Object.values(bundle).find(
    (value) =>
      value.type === "asset" &&
      value.fileName.startsWith("assets/tailscale-node-"),
  );
  assert.ok(root?.opensesameWorkerChunk);
  const files = Object.keys(root.opensesameWorkerChunk.modules).map(
    workerRealmSource,
  );
  assert.ok(files.includes(streamRegistry));
  assert.ok(files.includes(protocol));
  assert.ok(
    !files.some(
      (file) =>
        file?.endsWith("/controller-native-stream.ts") ||
        file?.endsWith("/controller-requests.ts"),
    ),
  );
  await evaluateProtocol(bundle, root, work);
});
test.each(["controller-native-stream.ts", "controller-requests.ts"])(
  "stream helper admission does not admit its adjacent host consumer: %s",
  async (file) => {
    await assert.rejects(
      fixture({
        extraImport: `import ${JSON.stringify(join(dirname(streamRegistry), file))};`,
      }),
      /Worker import crosses its private runtime boundary/,
    );
  },
);
test("the native stream registry stays excluded from password Worker realms", async () => {
  await assert.rejects(
    fixture({
      realm: "onepassword-sdk.worker",
      extraImport: `import ${JSON.stringify(streamRegistry)};`,
    }),
    /Worker import crosses its private runtime boundary/,
  );
});

test.each([
  ["worker-peer-get.ts", "WorkerPeerGET"],
  ["sdk-peer-get.ts", "bindNativePeerGET"],
])(
  "shipped peer adapter stays in the private native Worker graph: %s",
  async (file, exported) => {
    const adapter = join(dirname(streamRegistry), file);
    const { bundle, work } = await fixture({
      extraImport: `import {${exported}} from ${JSON.stringify(adapter)};globalThis.originalPeerAdapter=${exported};`,
    });
    const root = Object.values(bundle).find(
      (value) =>
        value.type === "asset" &&
        value.fileName.startsWith("assets/tailscale-node-"),
    );
    assert.ok(root?.opensesameWorkerChunk);
    const files = Object.keys(root.opensesameWorkerChunk.modules).map(
      workerRealmSource,
    );
    assert.ok(files.includes(adapter));
    assert.ok(files.includes(protocol));
    assert.ok(
      !files.some(
        (entry) =>
          entry?.endsWith("/controller-retirement.ts") ||
          entry?.endsWith("/controller-requests.ts"),
      ),
    );
    await evaluateProtocol(bundle, root, work);
  },
);

test.each(["worker-peer-get-extra.ts", "sdk-peer-get-helper.ts"])(
  "peer adapter admission rejects an actual adjacent near-name source: %s",
  async (neighbor) => {
    await assert.rejects(
      fixture({ neighbor }),
      /Worker import crosses its private runtime boundary/,
    );
  },
);

test.each(["worker-peer-get.ts", "sdk-peer-get.ts"])(
  "peer adapters remain outside password Worker realms: %s",
  async (file) => {
    await assert.rejects(
      fixture({
        realm: "onepassword-sdk.worker",
        extraImport: `import ${JSON.stringify(join(dirname(streamRegistry), file))};`,
      }),
      /Worker import crosses its private runtime boundary/,
    );
  },
);

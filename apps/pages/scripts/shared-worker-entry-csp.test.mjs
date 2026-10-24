import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, it as test } from "vitest";
import { sharedWorkerGraph } from "./shared-worker-graph.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const owner = join(
  repo,
  "apps/pages/scripts/fixtures/shared-worker-entry-csp-owner.ts",
);
const specifier = "../../src/modules/networking.tailnet/browser/worker.ts";
const dir = await mkdtemp(join(tmpdir(), "opensesame-worker-entry-csp-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

async function bundledEntry() {
  let bundle;
  await build({
    configFile: false,
    root: repo,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      sharedWorkerGraph({
        workers: [{ owner, specifier, name: "tailscale-node" }],
      }),
      {
        name: "capture-shipped-entry",
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
        output: { format: "es", onlyExplicitManualChunks: true },
      },
    },
  });
  const output = Object.values(bundle);
  const root = output.find(
    (item) =>
      item.type === "asset" &&
      item.fileName.startsWith("assets/tailscale-node-"),
  );
  assert.ok(root?.opensesameWorkerChunk);
  const input = join(dir, "entry.json");
  await writeFile(
    input,
    JSON.stringify({
      root: root.fileName,
      outputs: Object.fromEntries(
        output.map((item) => [
          item.fileName,
          item.type === "chunk" ? item.code : item.source,
        ]),
      ),
    }),
  );
  return input;
}

const runner = `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,SourceTextModule} from 'node:vm';
const {root,outputs}=JSON.parse(await readFile(process.argv[1],'utf8'));
const messages=[],listeners=new Map();let network=0;
const context=createContext({URL,TextEncoder,TextDecoder,EventTarget,Event,AbortController,atob,btoa,
addEventListener:(kind,callback)=>{assert.equal(kind,'message');assert.equal(listeners.has(kind),false);listeners.set(kind,callback)},
postMessage:value=>messages.push(value),fetch:()=>{network++;throw Error('Invalid start must not reach SDK fetch')}},
{codeGeneration:{strings:false,wasm:false}});
// Observe forbidden compilation attempts; never initialize or replace a parser.
const monitor=new SourceTextModule(\`globalThis.evalAttempts=0;
globalThis.Function=new Proxy(Function,{apply(target,receiver,args){globalThis.evalAttempts++;return Reflect.apply(target,receiver,args)},construct(target,args){globalThis.evalAttempts++;return Reflect.construct(target,args)}});\`,{context});
await monitor.link(()=>{throw Error('Monitor has no imports')});await monitor.evaluate();
const modules=new Map();const load=file=>{if(!modules.has(file))modules.set(file,new SourceTextModule(outputs[file],{context,identifier:file}));return modules.get(file)};
const actual=load(root);await actual.link((source,parent)=>load(new URL(source,'file:///'+parent.identifier).pathname.slice(1)));await actual.evaluate();
assert.equal(listeners.size,1);const receive=listeners.get('message');
receive({data:{kind:'nativeHTTPReady'}});
const config={hostname:'csp-browser',controlURL:'https://controlplane.tailscale.com',authKey:'',state:{},assets:{runtime:'https://assets.example/runtime.js',wasm:'https://assets.example/main.wasm.gz'},nativeHTTP:{routeMode:'peer',peerID:'',trustMode:'public',targets:[{origin:'https://byo.example.test',prefixes:['100.64.0.1/32']}]}};
receive({data:{kind:'start',config}});
receive({data:{kind:'start',config:{...config,nativeHTTP:{...config.nativeHTTP,peerID:'n-peer',exitNodeID:'unapproved-fallback'}}}});
receive({data:{kind:'nativeHTTPReady'}});
assert.deepEqual(JSON.parse(JSON.stringify(messages)),[{kind:'nativeHTTPReady',ready:false},{kind:'nativeHTTPReady',ready:false}]);
assert.equal(network,0,'Rejected peer starts cannot initialize SDK/network');
assert.equal(context.evalAttempts,0,'Actual production Worker must never probe dynamic compilation, even when Zod catches the CSP refusal');
process.stdout.write('actual-worker-entry-csp-ok');`;

test("the actual shipped Tailscale Worker initializes CSP-safe peer parsing before its first message", async () => {
  const input = await bundledEntry();
  const stdoutFile = join(dir, "entry.stdout");
  const stderrFile = join(dir, "entry.stderr");
  const stdout = await open(stdoutFile, "wx", 0o600);
  const stderr = await open(stderrFile, "wx", 0o600);
  let exit;
  try {
    exit = await new Promise((accept, reject) => {
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
  assert.equal(exit, 0, await readFile(stderrFile, "utf8"));
  assert.equal(
    await readFile(stdoutFile, "utf8"),
    "actual-worker-entry-csp-ok",
  );
});

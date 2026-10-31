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

async function bundledEntry(
  attempt,
  plan = { owner, specifier, name: "tailscale-node" },
) {
  let bundle;
  await build({
    configFile: false,
    root: repo,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      {
        name: "isolated-worker-owner",
        load(id) {
          if (plan.owner !== owner && id === plan.owner)
            return `export const start=()=>new Worker(new URL(${JSON.stringify(plan.specifier)},import.meta.url),{type:'module'});`;
        },
      },
      sharedWorkerGraph({
        workers: [plan],
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
        input: plan.owner,
        output: { format: "es", onlyExplicitManualChunks: true },
      },
    },
  });
  const output = Object.values(bundle);
  const root = output.find(
    (item) =>
      item.type === "asset" && item.fileName.startsWith(`assets/${plan.name}-`),
  );
  assert.ok(root?.opensesameWorkerChunk);
  const input = join(attempt, "entry.json");
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
location:new URL('https://app.example.test/assets/tailscale-node.js'),
addEventListener:(kind,callback)=>{assert.equal(kind,'message');assert.equal(listeners.has(kind),false);listeners.set(kind,callback)},
postMessage:value=>messages.push(value),fetch:()=>{network++;throw Error('Invalid start must not reach SDK fetch')}},
{codeGeneration:{strings:false,wasm:false}});
// Observe forbidden compilation attempts; never initialize or replace a parser.
const monitor=new SourceTextModule(\`globalThis.evalAttempts=0;
globalThis.Function=new Proxy(Function,{apply(target,receiver,args){globalThis.evalAttempts++;return Reflect.apply(target,receiver,args)},construct(target,args){globalThis.evalAttempts++;return Reflect.construct(target,args)}});\`,{context});
await monitor.link(()=>{throw Error('Monitor has no imports')});await monitor.evaluate();
const modules=new Map();const load=file=>{if(!modules.has(file))modules.set(file,new SourceTextModule(outputs[file],{context,identifier:file}));return modules.get(file)};
const actual=load(root);await actual.link((source,parent)=>load(new URL(source,'file:///'+parent.identifier).pathname.slice(1)));await actual.evaluate();
assert.equal(listeners.size,1);const dispatch=listeners.get('message');
const receive=event=>dispatch({origin:'',ports:[],...event});
// The page's end of a transferred MessageChannel: the handler the Worker binds, and what it replies.
const channel=()=>{const port={onmessage:null,replies:[],postMessage:value=>port.replies.push(value)};return port};
const config={hostname:'csp-browser',controlURL:'https://controlplane.tailscale.com',authKey:'',state:{},assets:{runtime:'https://assets.example/runtime.js',wasm:'https://assets.example/main.wasm.gz'},nativeHTTP:{routeMode:'peer',peerID:'',trustMode:'public',targets:[{origin:'https://byo.example.test',prefixes:['100.64.0.1/32']}]}};
const peer={...config,nativeHTTP:{...config.nativeHTTP,peerID:'n-peer'}};
const foreign=channel();
receive({origin:'https://foreign.example.test',data:{kind:'start',config:peer},ports:[foreign]});
assert.equal(foreign.onmessage,null,'Cross-origin messages cannot reach the Worker');
receive({data:{kind:'nativeHTTPReady'}});
const rejected=channel();
receive({data:{kind:'start',config},ports:[rejected]});
receive({data:{kind:'start',config:{...peer,nativeHTTP:{...peer.nativeHTTP,exitNodeID:'unapproved-fallback'}}},ports:[rejected]});
assert.equal(rejected.onmessage,null,'Rejected peer starts bind no channel');
assert.equal(network,0,'Rejected peer starts cannot initialize SDK/network');
const bound=channel();
receive({data:{kind:'start',config:peer},ports:[bound]});
assert.equal(typeof bound.onmessage,'function','A valid peer start binds its one transferred port');
bound.onmessage({data:{kind:'nativeHTTPReady'}});
await new Promise(resolve=>setTimeout(resolve,0));
assert.deepEqual(JSON.parse(JSON.stringify(bound.replies)),[{kind:'nativeHTTPReady',ready:false},{kind:'error'}]);
assert.deepEqual(messages,[],'Nothing is answered on the Worker channel');
assert.equal(network,0,'Assets off this deployment never reach SDK fetch');
assert.equal(context.evalAttempts,0,'Actual production Worker must never probe dynamic compilation, even when Zod catches the CSP refusal');
process.stdout.write('actual-worker-entry-csp-ok');`;

test("the actual shipped Tailscale Worker initializes CSP-safe peer parsing before its first message", async () => {
  const attempt = await mkdtemp(join(dir, "attempt-"));
  const input = await bundledEntry(attempt);
  const stdoutFile = join(attempt, "entry.stdout");
  const stderrFile = join(attempt, "entry.stderr");
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

test("the actual Bitwarden Secrets Worker initializes CSP-safe schemas in its own realm", async () => {
  const attempt = await mkdtemp(join(dir, "bitwarden-"));
  const input = await bundledEntry(attempt, {
    owner: join(
      repo,
      "packages/app-core/src/lib/secret-backends/bitwarden-wasm-loader.ts",
    ),
    specifier: "./bitwarden-secrets.worker.ts",
    name: "bitwarden-secrets.worker",
  });
  // No document boot, fixture config, or schema replacement reaches this realm.
  const script = `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,SourceTextModule} from 'node:vm';
const {root,outputs}=JSON.parse(await readFile(process.argv[1],'utf8'));
const replies=[];let network=0;
const context=createContext({URL,TextEncoder,TextDecoder,Response,Headers,AbortController,setTimeout,clearTimeout,atob,btoa,
location:new URL('https://app.example.test/'+root),postMessage:value=>replies.push(value),
fetch:()=>{network++;throw Error('Invalid messages must not reach SDK fetch')}},
{codeGeneration:{strings:false,wasm:false}});
const monitor=new SourceTextModule(\`globalThis.self=globalThis;globalThis.evalAttempts=0;
globalThis.Function=new Proxy(Function,{apply(target,receiver,args){globalThis.evalAttempts++;return Reflect.apply(target,receiver,args)},construct(target,args){globalThis.evalAttempts++;return Reflect.construct(target,args)}});\`,{context});
await monitor.link(()=>{throw Error('Monitor has no imports')});await monitor.evaluate();
const modules=new Map();const load=file=>{if(!modules.has(file))modules.set(file,new SourceTextModule(outputs[file],{context,identifier:file,initializeImportMeta(meta){meta.url='https://app.example.test/'+file}}));return modules.get(file)};
const actual=load(root);await actual.link((source,parent)=>load(new URL(source,'file:///'+parent.identifier).pathname.slice(1)));await actual.evaluate();
assert.equal(typeof context.onmessage,'function');
context.onmessage({origin:'https://foreign.example.test',data:{}});
context.onmessage({origin:'',data:{type:'initialize',id:1,settings:{}}});
await new Promise(resolve=>setTimeout(resolve,0));
assert.deepEqual(JSON.parse(JSON.stringify(replies)),[{id:-1,ok:false,result:''}]);
assert.equal(network,0);assert.equal(context.__zod_globalConfig.jitless,true);
assert.equal(context.evalAttempts,0,'The actual worker must not probe Function while constructing or parsing its schemas');`;
  let stderr = "";
  const exit = await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-vm-modules", "--input-type=module", "-e", script, input],
      {
        stdio: ["ignore", "ignore", "pipe"],
        signal: AbortSignal.timeout(5000),
      },
    );
    child.stderr.setEncoding("utf8").on("data", (value) => {
      stderr += value;
    });
    child.once("error", reject);
    child.once("close", accept);
  });
  assert.equal(exit, 0, stderr);
});

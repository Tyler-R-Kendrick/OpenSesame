import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "vite";
import { afterAll, beforeAll, it } from "vitest";
import {
  accessToken,
  organizationId,
  projectId,
  secretsManagerFixture,
} from "../../../packages/app-core/src/lib/secret-backends/bitwarden-secrets.test-support.ts";
import { createBitwardenSecretsBackend } from "../../../packages/app-core/src/lib/secret-backends/bitwarden-secrets.ts";
import artifact from "../../../packages/app-core/src/lib/secret-backends/bitwarden-wasm-artifact.json" with {
  type: "json",
};
import { createBitwardenWorkerHttp } from "../../../packages/app-core/src/lib/secret-backends/bitwarden-worker-http.ts";
import { sharedWorkerGraph } from "./shared-worker-graph.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "opensesame-bws-gzip-"));
const owner = join(
  repo,
  "packages/app-core/src/lib/secret-backends/bitwarden-wasm-loader.ts",
);
const plan = {
  owner,
  specifier: "./bitwarden-secrets.worker.ts",
  name: "bitwarden-secrets.worker",
};
let bundle;
let entry;
beforeAll(async () => {
  const input = join(root, "host.ts");
  await writeFile(
    input,
    `import {createBrowserBitwardenClient} from ${JSON.stringify(owner)}; globalThis.client=createBrowserBitwardenClient;`,
  );
  await build({
    configFile: false,
    root: repo,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      sharedWorkerGraph({ workers: [plan] }),
      {
        name: "capture-compiled-bws-gzip",
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
    build: {
      write: false,
      minify: false,
      target: "es2022",
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
  entry = Object.values(bundle).find(
    (output) => output.opensesameWorkerChunk?.name === plan.name,
  )?.fileName;
  assert.ok(entry);
  assert.equal(
    Object.values(bundle).filter((output) => output.fileName.endsWith(".gz"))
      .length,
    1,
  );
  assert.ok(
    !Object.values(bundle).some((output) => output.fileName.endsWith(".wasm")),
  );
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function serve(mode) {
  const requests = [];
  const server = createServer((request, response) => {
    const path = request.url.slice("/subpath/".length);
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    const output = bundle[path];
    if (!output) {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = Buffer.from(
      output.type === "chunk" ? output.code : output.source,
    );
    if (path.endsWith(".gz")) {
      if (mode === "corrupt") {
        body = Buffer.from(body);
        body[16] ^= 1;
      }
      if (mode === "truncated") body = body.subarray(0, body.length - 1);
    } else if (mode === "raw-pin" && path === entry) {
      const source = body.toString("utf8");
      assert.equal(source.split(artifact.raw.hash).length, 2);
      body = Buffer.from(source.replace(artifact.raw.hash, "0".repeat(64)));
    }
    response.writeHead(200, {
      "Content-Type": path.endsWith(".gz")
        ? "application/gzip"
        : "text/javascript",
    });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}/subpath/`;
  return {
    origin,
    requests,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

const runner = `
const {parentPort,workerData}=require("node:worker_threads");
const {createContext,SourceTextModule}=require("node:vm");
const context=createContext({
 AbortController,AbortSignal,Blob,crypto,console,DecompressionStream,fetch,
 Headers,Request,Response,ReadableStream,TransformStream,TextDecoder,TextEncoder,
 Uint8Array,ArrayBuffer,DataView,URL,setTimeout,clearTimeout,
 WebAssembly:new Proxy(WebAssembly,{get(target,key){
  if(key!=="instantiate")return target[key];
  return(...args)=>{parentPort.postMessage({type:"instantiated"});return WebAssembly.instantiate(...args);};
 }})
},{codeGeneration:{strings:false,wasm:true}});
context.self=context;
// A dedicated Worker's own location: the script URL it was started from.
context.location=new URL(workerData.url);
context.postMessage=message=>parentPort.postMessage(message);
context.close=()=>parentPort.close();
const modules=new Map();
async function load(url){
 if(!modules.has(url))modules.set(url,(async()=>{
  const response=await fetch(url);
  if(response.status!==200)throw new Error("Compiled module HTTP failed");
  return new SourceTextModule(await response.text(),{
   context,identifier:url,initializeImportMeta(meta){meta.url=url;}
  });
 })());
 return modules.get(url);
}
(async()=>{
 const module=await load(workerData.url);
 await module.link((specifier,parent)=>load(new URL(specifier,parent.identifier).href));
 await module.evaluate();
 // A message from another origin is dropped; the parent's arrive with origin "".
 context.onmessage({origin:"https://foreign.example.test",data:{type:"free",id:0}});
 parentPort.on("message",data=>context.onmessage({origin:"",data}));
 parentPort.postMessage({type:"ready"});
})().catch(error=>{throw error;});
`;
async function compiledWorker(http, settings) {
  const pending = new Map();
  const forward = createBitwardenWorkerHttp(settings, fetch);
  let sequence = 0;
  let instantiations = 0;
  let freed;
  const worker = new Worker(runner, {
    eval: true,
    execArgv: ["--experimental-vm-modules"],
    workerData: { url: new URL(entry, http.origin).href },
  });
  const exit = once(worker, "exit");
  const ready = new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.on("message", (message) => {
      if (message.type === "ready") {
        resolve();
        return;
      }
      if (message.type === "instantiated") {
        instantiations++;
        return;
      }
      if (message.type === "fetch") {
        void forward(message).then(
          (reply) => worker.postMessage(reply),
          reject,
        );
        return;
      }
      const operation = pending.get(message.id);
      assert.ok(
        operation,
        "worker reply must belong to an outstanding request",
      );
      pending.delete(message.id);
      operation(message);
    });
  });
  await ready;
  function send(operation) {
    const id = ++sequence;
    const reply = new Promise((resolve) => pending.set(id, resolve));
    worker.postMessage({ ...operation, id });
    return reply;
  }
  return {
    initialize: () => send({ type: "initialize", settings }),
    instantiations: () => instantiations,
    client: {
      async run_command(command) {
        const reply = await send({ type: "command", command });
        assert.equal(reply.ok, true);
        return reply.result;
      },
      free() {
        freed = send({ type: "free" });
      },
    },
    async close() {
      if (!freed) freed = send({ type: "free" });
      assert.deepEqual(await freed, { id: sequence, ok: true, result: "null" });
      assert.deepEqual(await exit, [0]);
      assert.equal(pending.size, 0);
    },
    dispose: () => worker.terminate(),
  };
}

function configuration(url) {
  return {
    providerId: "bitwarden",
    name: "Secrets Manager",
    mode: "bitwarden-secrets",
    baseUrl: `${url}/api`,
    identityUrl: `${url}/identity`,
    organizationId,
    projectId,
    token: accessToken,
    vaultId: "",
    environment: "",
    secretPath: "",
    clientId: "",
    clientSecret: "",
    passwordListId: "",
    fileFormat: "",
  };
}
it("initializes real compiled BWS glue/WASM, authenticates, reads encrypted content and frees the worker", async () => {
  const http = await serve("complete");
  const provider = await secretsManagerFixture();
  let worker;
  try {
    const backend = createBitwardenSecretsBackend(
      undefined,
      async (settings) => {
        worker = await compiledWorker(http, settings);
        assert.equal((await worker.initialize()).ok, true);
        return worker.client;
      },
    );
    const session = await backend.authenticate(configuration(provider.url));
    const created = await backend.createItem(
      {
        name: "Compressed worker",
        secret: "authenticated-secret",
        notes: "authenticated-note",
      },
      session,
    );
    assert.equal(
      (await backend.getItem(created.id, session)).secret,
      "authenticated-secret",
    );
    assert.equal(
      await backend.getNotes(created.id, session),
      "authenticated-note",
    );
    assert.ok(
      provider.requests.some(
        (request) => request.path === "/identity/connect/token",
      ),
    );
    assert.ok(
      provider.requests.some(
        (request) => request.path === `/api/secrets/${created.id}`,
      ),
    );
    assert.ok(
      provider.requests.every(
        (request) => !request.body.includes("authenticated-secret"),
      ),
    );
    assert.equal(worker.instantiations(), 1);
    await backend.disconnect(session);
    await worker.close();
    const assets = http.requests.filter((request) =>
      request.path.endsWith(".gz"),
    );
    assert.equal(assets.length, 1);
    assert.deepEqual(assets[0], {
      path: assets[0].path,
      authorization: undefined,
      cookie: undefined,
    });
  } finally {
    await worker?.dispose();
    await http.close();
    await provider.close();
  }
});
it.each(["corrupt", "truncated", "raw-pin"])(
  "rejects %s actual HTTP delivery before WASM instantiation",
  async (mode) => {
    const http = await serve(mode);
    try {
      const worker = await compiledWorker(http, {
        apiUrl: "https://api.example.com",
        identityUrl: "https://identity.example.com",
      });
      assert.equal((await worker.initialize()).ok, false);
      assert.equal(worker.instantiations(), 0);
      await worker.close();
      assert.equal(
        http.requests.filter((request) => request.path.endsWith(".gz")).length,
        1,
      );
      assert.ok(
        http.requests.every(
          (request) => !request.authorization && !request.cookie,
        ),
      );
    } finally {
      await http.close();
    }
  },
);

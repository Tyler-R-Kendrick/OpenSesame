import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** This function is compiled with the actual imports in every emitted realm. */
export function codecFixture(fns) {
  const {
    bytesToB64,
    b64ToBytes,
    createGzipWasmAssetFetch,
    BitwardenCommandSchema,
    NativeWorkerRequest,
    NativeFetchRequest,
  } = fns;
  globalThis.codecFixture = () => {
    const wire = bytesToB64(new Uint8Array([0, 1, 254, 255]));
    return {
      wire,
      decoded: [...b64ToBytes(wire)].join(","),
      valid: NativeWorkerRequest.safeParse({ type: "list", id: 1 }).success,
      extra: NativeWorkerRequest.safeParse({ type: "list", id: 1, extra: true })
        .success,
      bws: BitwardenCommandSchema.safeParse({
        secrets: { get: { id: "12345678-1234-4234-8234-123456789012" } },
      }).success,
      wrong: BitwardenCommandSchema.safeParse({
        secrets: { get: { id: "bad" } },
      }).success,
      network: NativeFetchRequest.safeParse({
        type: "native-fetch",
        id: 1,
        url: "https://owned.test",
        method: "GET",
        headers: [],
        body: "",
      }).success,
    };
  };
  globalThis.gzipFixture = async (fixture) => {
    const owner = new AbortController();
    let reads = 0;
    const failure = () => new Error("pinned-codec-failure");
    const url = "https://owned.test/exact.wasm.gz";
    const fetcher = createGzipWasmAssetFetch(
      { url, compressed: fixture.compressed, raw: fixture.raw },
      owner.signal,
      () => owner.signal.throwIfAborted(),
      async () => {
        reads++;
        const response = new Response(new Uint8Array(fixture.wire));
        Object.defineProperty(response, "url", { value: url });
        return response;
      },
      failure,
    );
    const decoded = [
      ...new Uint8Array(await (await fetcher(url)).arrayBuffer()),
    ].join(",");
    let wrong = false;
    try {
      await fetcher("https://owned.test/sibling.wasm.gz");
    } catch {
      wrong = true;
    }
    owner.abort();
    let aborted = false;
    try {
      await fetcher(url);
    } catch {
      aborted = true;
    }
    return { decoded, reads, wrong, aborted };
  };
}
const runner = `
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {createContext,SourceTextModule} from "node:vm";
import {readFile} from "node:fs/promises";
const {outputs,roots,known}=JSON.parse(await readFile(process.argv[1],"utf8"));
const realms=[];
for(const [index,entry]of roots.entries()){
 const context=createContext({TextEncoder,TextDecoder,crypto:webcrypto,atob,AbortController,AbortSignal,Request,Response,Blob,ReadableStream,TransformStream,DecompressionStream},{codeGeneration:{strings:false,wasm:false}});
 const modules=new Map();
 const load=file=>{if(!modules.has(file))modules.set(file,new SourceTextModule(outputs[file],{context,identifier:file}));return modules.get(file);};
 const module=load(entry);
 await module.link((source,parent)=>load(new URL(source,"file:///"+parent.identifier).pathname.slice(1)));
 await module.evaluate();
 assert.equal(context.__zod_globalConfig.jitless,true);
 assert.equal(context.hostOnly,index===0?true:undefined);
 assert.equal(context.workerOnly,index===0?undefined:true);
 const codec=context.codecFixture();
 assert.equal(codec.wire,"AAH+/w==");assert.equal(codec.decoded,"0,1,254,255");
 assert.equal(codec.valid,true);assert.equal(codec.extra,false);assert.equal(codec.bws,true);assert.equal(codec.wrong,false);assert.equal(codec.network,true);
 const gzip=await context.gzipFixture(known);
 assert.equal(gzip.decoded,"0,97,115,109,1,0,0,0");assert.equal(gzip.reads,1);assert.equal(gzip.wrong,true);assert.equal(gzip.aborted,true);
 await assert.rejects(()=>context.gzipFixture({...known,wire:known.wire.map((n,i)=>i===5?n^1:n)}),/pinned-codec-failure/);
 assert.throws(()=>context.codecFns.b64ToBytes("%%%%"));
 realms.push(context);
}
for(const name of ["bytesToB64","b64ToBytes","createGzipWasmAssetFetch","BitwardenCommandSchema","NativeWorkerRequest","NativeFetchRequest"]){
 assert.notEqual(realms[0].codecFns[name],realms[1].codecFns[name]);
 realms[0].codecFns[name].owned="host";realms[1].codecFns[name].owned="worker-one";
 assert.equal(realms[2].codecFns[name].owned,undefined);assert.equal(realms[0].codecFns[name].owned,"host");
}
realms[0].codecFns.bitwardenNativeCapabilities.itemKinds.push("host-owned");
realms[1].codecFns.bitwardenNativeCapabilities.itemKinds.push("worker-one-owned");
assert.equal(realms[2].codecFns.bitwardenNativeCapabilities.itemKinds.includes("host-owned"),false);
assert.equal(realms[2].codecFns.bitwardenNativeCapabilities.itemKinds.includes("worker-one-owned"),false);
assert.equal(realms[0].codecFns.bitwardenNativeCapabilities.itemKinds.includes("worker-one-owned"),false);
realms[0].__zod_globalConfig.realmOwner="host";assert.equal(realms[1].__zod_globalConfig.realmOwner,undefined);
process.stdout.write("isolated-closed-codecs-ok");`;

export async function assertIsolatedCodecs(values, roots, dir, known) {
  const input = join(dir, "codec-realms.json");
  await writeFile(
    input,
    JSON.stringify({
      outputs: Object.fromEntries(
        values.map((value) => [
          value.fileName,
          value.type === "chunk" ? value.code : value.source,
        ]),
      ),
      roots: roots.map((root) => root.fileName),
      known,
    }),
  );
  const stdout = await open(join(dir, "codecs.stdout"), "wx", 0o600);
  const stderrFile = join(dir, "codecs.stderr");
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
    await readFile(join(dir, "codecs.stdout"), "utf8"),
    "isolated-closed-codecs-ok",
  );
}

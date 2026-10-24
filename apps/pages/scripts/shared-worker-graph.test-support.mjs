import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function assertIsolatedParsers(outputs, roots, dir) {
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

/** Run the emitted shared bytes in separate browser-like host/Worker realms. */
export async function assertIsolatedCrypto(values, roots, dir, known) {
  const runner = `
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {createContext,SourceTextModule} from "node:vm";
import {readFile} from "node:fs/promises";
const {outputs,roots,known}=JSON.parse(await readFile(process.argv[1],"utf8"));
const realms=[];
for(const [index,entry]of roots.entries()){
 const context=createContext({TextEncoder,TextDecoder,crypto:webcrypto,...(index===0?{Buffer}:{})},{codeGeneration:{strings:false,wasm:true}});
 const modules=new Map();
 const load=file=>{if(!modules.has(file))modules.set(file,new SourceTextModule(outputs[file],{context,identifier:file}));return modules.get(file);};
 const module=load(entry);
 await module.link((source,parent)=>load(new URL(source,"file:///"+parent.identifier).pathname.slice(1)));
 await module.evaluate();
 assert.equal(context.__zod_globalConfig.jitless,true);
 if(index===0)assert.equal(context.hostOnly,"host");
 else{assert.equal(context.hostOnly,undefined);assert.equal(context.Buffer,undefined);assert.ok(context.realmName);}
 const cbor=context.cborFixture();
 assert.equal(cbor.hex,"a20142070802d8186178");assert.equal(cbor.tag,24);assert.equal(cbor.value,"x");
 assert.throws(()=>context.cborInvalid());
 realms.push(context);
}
for(const worker of realms.slice(1)){
 assert.notEqual(worker.cryptoFns.argon2id,realms[0].cryptoFns.argon2id);
 assert.notEqual(worker.cryptoFns.CBORTag,realms[0].cryptoFns.CBORTag);
}
realms[0].cryptoFns.argon2id.owned="host";
realms[0].cryptoFns.CBORTag.prototype.owned="host";
realms[1].cryptoFns.argon2id.owned="worker-one";
realms[1].cryptoFns.CBORTag.prototype.owned="worker-one";
assert.equal(realms[2].cryptoFns.argon2id.owned,undefined);
assert.equal(realms[2].cryptoFns.CBORTag.prototype.owned,undefined);
assert.equal(realms[0].cryptoFns.argon2id.owned,"host");
assert.equal(realms[0].cryptoFns.CBORTag.prototype.owned,"host");
const hex=value=>Buffer.from(value).toString("hex");
assert.equal(hex(await realms[0].kdbx(known.salt)),known.argon2d);
assert.equal(hex(await realms[0].kdbx(known.salt,2)),"1072b2ab89197fe4d3f045d8de896beca52daccc98b5d86be47bd6aa05975988");
await assert.rejects(()=>realms[0].kdbx(known.salt,0,0x10),/version 1.0/);
await Promise.all(realms.slice(1).map(async worker=>{
 assert.equal(hex(await worker.derive(1)),"1072b2ab89197fe4d3f045d8de896beca52daccc98b5d86be47bd6aa05975988");
 assert.equal(hex(await worker.derive(2)),"cc6502d85b2952dca321885eb912df152f555ea13f7d66953465d354770f81c1");
}));
process.stdout.write("isolated-official-crypto-kdf-cbor-ok");`;
  const input = join(dir, "crypto-realms.json");
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
  const stdout = await open(join(dir, "crypto.stdout"), "wx", 0o600);
  const stderrFile = join(dir, "crypto.stderr");
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
    await readFile(join(dir, "crypto.stdout"), "utf8"),
    "isolated-official-crypto-kdf-cbor-ok",
  );
}

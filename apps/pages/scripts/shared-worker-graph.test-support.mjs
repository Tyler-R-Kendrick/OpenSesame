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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { it } from "vitest";
import { zodCsp } from "./zod-csp-plugin.mjs";

async function bundledSchema(enabled) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  return build({
    configFile: false,
    root,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      enabled && zodCsp(),
      {
        name: "schema-first-fixture",
        resolveId(id) {
          if (id === "fixture") return "\0fixture";
        },
        load(id) {
          if (id === "\0fixture")
            return 'import {z} from "zod"; const schema=z.object({ok:z.boolean()}); export const parsed=schema.parse({ok:true}); export const rejected=!schema.safeParse({ok:"invalid"}).success;';
        },
      },
    ],
    build: {
      write: false,
      target: "esnext",
      minify: true,
      rollupOptions: {
        input: "fixture",
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          onlyExplicitManualChunks: true,
          manualChunks(id) {
            if (id.includes("/node_modules/zod/")) return "schemas";
            if (id.endsWith("/zod-jitless.ts")) return "configuration";
          },
        },
      },
    },
  });
}

function assertColdSchema(result, enabled) {
  const chunks = result.output.filter((item) => item.type === "chunk");
  const entry = chunks.find((item) => item.isEntry).fileName;
  const dir = mkdtempSync(join(tmpdir(), "zod-csp-"));
  const fixture = join(dir, "chunks.json");
  writeFileSync(fixture, JSON.stringify({ chunks, entry }));
  const probe = spawnSync(
    process.execPath,
    [
      "--experimental-vm-modules",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import {readFileSync} from 'node:fs';
    const {chunks,entry}=JSON.parse(readFileSync(process.argv[1],'utf8'));
    const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
    vm.runInContext('globalThis.attempts=0;globalThis.Function=new Proxy(Function,{construct(){attempts++;throw Error("CSP probe");},apply(){attempts++;throw Error("CSP probe");}})',context);
    const modules=new Map(chunks.map(c=>[c.fileName,new vm.SourceTextModule(c.code,{context,identifier:c.fileName})]));
    const main=modules.get(entry);
    await main.link((specifier,ref)=>modules.get(new URL(specifier,'https://fixture/'+ref.identifier).pathname.slice(1)));
    await main.evaluate();
    assert.equal(context.attempts, ${enabled ? 0 : 1});
    assert.equal(context.__zod_globalConfig?.jitless, ${enabled ? "true" : "undefined"});
    assert.equal(main.namespace.parsed.ok,true);
    assert.equal(main.namespace.rejected,true);
  `,
      fixture,
    ],
    { encoding: "utf8" },
  );
  rmSync(dir, { recursive: true, force: true });
  assert.equal(probe.status, 0, probe.stderr);
}

it.each([false, true])(
  "cold split schema configuration enabled=%s",
  async (enabled) => {
    assertColdSchema(await bundledSchema(enabled), enabled);
  },
);

it("matches installed core files without transforming unrelated modules", () => {
  const plugin = zodCsp();
  const file =
    "/repo/node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/core.js";
  for (const id of [file, `${file}?v=123`, file.replaceAll("/", "\\")]) {
    const result = plugin.transform("original", id);
    assert.ok(result.code.startsWith("import "));
    assert.ok(result.code.endsWith("\noriginal"));
  }
  for (const id of [
    `${file}x`,
    "/repo/zod/v4/core/core.js",
    file.replace("core.js", "util.js"),
  ])
    assert.equal(plugin.transform("original", id), null);
});

/** Official emitted reflection metadata, native-collection support and realm isolation. */
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Script, createContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { beforeAll, it as test } from "vitest";
import {
  readSamlBrowserCryptoInputs,
  samlBrowserCrypto,
} from "./saml-browser-crypto.mjs";
const root = process.cwd().endsWith("/apps/pages")
  ? resolve(process.cwd(), "../..")
  : process.cwd();
const input = readSamlBrowserCryptoInputs(root);
const owner = createRequire(input.sharedCertificate);
const reflection = {
  full: realpathSync(owner.resolve("reflect-metadata")),
  lite: realpathSync(owner.resolve("reflect-metadata/lite")),
};
const entry = "\0owned-reflection-test";
const reflectionExercise = `
class Base{};class Derived extends Base{};
const symbol=Symbol("metadata");
export const realmReflect=Reflect;
export const target=Derived;
export function exercise(){
 Reflect.defineMetadata("owner","base",Base);
 Reflect.defineMetadata(symbol,42,Base.prototype,"field");
 Reflect.defineMetadata("own","derived",Derived);
 const inherited=Reflect.getMetadata("owner",Derived);
 const own=Reflect.getOwnMetadata("owner",Derived);
 const property=Reflect.getMetadata(symbol,Derived.prototype,"field");
 const hasOwn=Reflect.hasOwnMetadata("owner",Derived);
 const keys=Reflect.getMetadataKeys(Derived).join(",");
 const ownKeys=Reflect.getOwnMetadataKeys(Derived).join(",");
 Reflect.metadata("decorator","applied")(Derived);
 const decorated=Reflect.decorate([target=>{Reflect.defineMetadata("order",1,target);}],Derived);
 const decoration=Reflect.getMetadata("decorator",decorated);
 Reflect.defineMetadata("owner","override",Derived);
 const deleted=Reflect.deleteMetadata("owner",Derived);
 const fallback=Reflect.getMetadata("owner",Derived);
 const absent=Reflect.deleteMetadata("missing",Derived);
 return JSON.stringify({inherited,own,property,hasOwn,keys,ownKeys,decoration,deleted,fallback,absent});
}`;
let full;
let lite;
async function compile(plugins, specifier = "reflect-metadata") {
  const result = await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      {
        name: "reflection-owner-entry",
        resolveId(source, importer) {
          if (source === entry) return entry;
          if (importer === entry && source.startsWith("reflect-metadata"))
            return this.resolve(source, input.sharedCertificate, {
              skipSelf: true,
            });
        },
        load(id) {
          if (id === entry)
            return `import ${JSON.stringify(specifier)};${reflectionExercise}`;
        },
      },
      ...plugins,
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
        input: entry,
        preserveEntrySignatures: "strict",
        output: {
          format: "iife",
          name: "ReflectionFixture",
          extend: true,
          inlineDynamicImports: true,
        },
      },
    },
  });
  const chunks = result.output.filter((value) => value.type === "chunk");
  assert.equal(chunks.length, 1);
  return chunks[0];
}
async function realm(code, missing) {
  const context = createContext(missing ? { [missing]: undefined } : {}, {
    codeGeneration: { strings: false, wasm: false },
  });
  new Script(code).runInContext(context);
  return context.ReflectionFixture;
}
beforeAll(async () => {
  full = await compile([]);
  lite = await compile([samlBrowserCrypto(root)]);
});
test("same official package exports lite while retaining full implementation for explicit imports", async () => {
  const metadata = JSON.parse(
    readFileSync(resolve(reflection.full, "../package.json")),
  );
  assert.equal(metadata.name, "reflect-metadata");
  assert.equal(metadata.version, "0.2.2");
  assert.equal(metadata.exports["./lite"].default, "./ReflectLite.js");
  assert.ok(reflection.full in full.modules);
  assert.ok(reflection.lite in lite.modules);
  assert.ok(!(reflection.full in lite.modules));
  const explicit = await compile(
    [samlBrowserCrypto(root)],
    "reflect-metadata/Reflect.js",
  );
  assert.ok(reflection.full in explicit.modules);
  assert.ok(!(reflection.lite in explicit.modules));
  assert.ok(lite.code.length < full.code.length);
  assert.ok(
    gzipSync(lite.code, { level: 9 }).length <
      gzipSync(full.code, { level: 9 }).length,
  );
});
test("actual emitted lite matches full metadata inheritance, own keys, decorators and deletion", async () => {
  const original = await realm(full.code);
  const compiled = await realm(lite.code);
  const result = compiled.exercise();
  assert.equal(result, original.exercise());
  assert.deepEqual(JSON.parse(result), {
    inherited: "base",
    property: 42,
    hasOwn: false,
    keys: "own,owner",
    ownKeys: "own",
    decoration: "applied",
    deleted: true,
    fallback: "base",
    absent: false,
  });
});
test("host and two Worker realms retain separate metadata registries and API instances under CSP", async () => {
  const realms = await Promise.all([
    realm(lite.code),
    realm(lite.code),
    realm(lite.code),
  ]);
  realms[0].realmReflect.defineMetadata("owner", "host", realms[0].target);
  realms[1].realmReflect.defineMetadata(
    "owner",
    "worker-one",
    realms[1].target,
  );
  assert.equal(
    realms[2].realmReflect.getMetadata("owner", realms[2].target),
    undefined,
  );
  assert.equal(
    realms[2].realmReflect.getMetadata("owner", realms[0].target),
    undefined,
  );
  assert.equal(
    realms[0].realmReflect.getMetadata("owner", realms[0].target),
    "host",
  );
  realms[0].realmReflect.defineMetadata.owned = "host";
  assert.equal(realms[1].realmReflect.defineMetadata.owned, undefined);
  assert.notEqual(
    realms[0].realmReflect.defineMetadata,
    realms[1].realmReflect.defineMetadata,
  );
});
test.each(["Map", "Set", "WeakMap"])(
  "official lite fails closed without native %s",
  async (missing) => {
    await assert.rejects(
      realm(lite.code, missing),
      /valid (Map|Set|WeakMap) constructor could not be found/,
    );
  },
);
test("nonbare imports and different package instances retain original resolver behavior", async () => {
  const plugin = samlBrowserCrypto(root);
  plugin.buildStart();
  const different = {
    resolve: async () => ({ id: "/other-instance/Reflect.js" }),
  };
  assert.equal(
    await plugin.resolveId.call(different, "reflect-metadata", "/owner.ts"),
    null,
  );
  const untouched = {
    resolve() {
      throw new Error("Must not resolve a nonbare import");
    },
  };
  assert.equal(
    await plugin.resolveId.call(
      untouched,
      "reflect-metadata/lite",
      "/owner.ts",
    ),
    null,
  );
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { kdbxNativeDOM } from "./kdbx-native-dom-plugin.mjs";

const root =
  process.env.PAGES_KDBX_TEST_ROOT ??
  fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(resolve(root, "apps/pages/package.json"));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
const { chromium } = require("@playwright/test");
const coreRequire = createRequire(
  resolve(root, "packages/app-core/package.json"),
);
const entry = `
import * as sdk from ${JSON.stringify(coreRequire.resolve("kdbxweb"))};
import { keepassKdbx } from ${JSON.stringify(resolve(root, "packages/app-core/src/lib/vault/import/formats/kdbx.ts"))};
globalThis.kdbxSDK = sdk;
globalThis.runKdbxProof = async (fixture) => {
  const pass = "browser-roundtrip";
  const credentials = (value) => new sdk.Credentials(sdk.ProtectedValue.fromString(value));
  const db = sdk.Kdbx.create(credentials(pass), "Native XML");
  db.setVersion(3);
  db.header.keyEncryptionRounds = 10;
  const item = db.createEntry(db.getDefaultGroup());
  item.fields.set("Title", "Native <XML> & Unicode 雪");
  item.fields.set("UserName", "reader");
  item.fields.set("Password", sdk.ProtectedValue.fromString("protected-roundtrip"));
  const saved = await db.save();
  const loaded = await sdk.Kdbx.load(saved.slice(0), credentials(pass));
  const restored = loaded.getDefaultGroup().entries[0];
  const input = (bytes, password) => ({fileName:"roundtrip.kdbx",text:"",headers:null,json:null,bytes:new Uint8Array(bytes),password});
  const parsed = await keepassKdbx.parse(input(saved, pass));
  const rejected = async (operation) => {try {await operation();return false;}catch{return true;}};
  const corrupt = new Uint8Array(saved.slice(0));
  corrupt[corrupt.length - 1] ^= 1;
  const external = await keepassKdbx.parse(input(new Uint8Array(fixture).buffer, "correct horse battery staple"));
  return {
    native: typeof DOMParser === "function" && typeof XMLSerializer === "function" && !!crypto.subtle,
    magic: new DataView(saved).getUint32(0,true),
    title: restored.fields.get("Title"),
    protected: restored.fields.get("Password") instanceof sdk.ProtectedValue,
    secret: restored.fields.get("Password").getText(),
    parsed,
    wrongPassword: await rejected(() => sdk.Kdbx.load(saved.slice(0),credentials("wrong"))),
    corruption: await rejected(() => sdk.Kdbx.load(corrupt.buffer,credentials(pass))),
    importerWrongPassword: await rejected(() => keepassKdbx.parse(input(saved,"wrong"))),
    importerCorruption: await rejected(() => keepassKdbx.parse(input(corrupt.buffer,pass))),
    malformedXML: await rejected(() => sdk.XmlUtils.parse("<Root><missing></Root>")),
    externalCount: external.items.length,
    externalSecrets: external.items.filter((draft) => draft.kind === "account").map((draft) => draft.password),
  };
};
`;

async function buildProofChunks() {
  const built = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      kdbxNativeDOM(root),
      {
        name: "owned-kdbx-browser-entry",
        resolveId: (id) => (id === "kdbx-proof" ? "\0kdbx-proof" : null),
        load: (id) => (id === "\0kdbx-proof" ? entry : null),
      },
    ],
    build: {
      write: false,
      target: "es2022",
      minify: false,
      rollupOptions: {
        input: "kdbx-proof",
        output: { format: "es", inlineDynamicImports: true },
      },
    },
  });
  const chunks = built.output.filter((output) => output.type === "chunk");
  assert.equal(chunks.length, 1);
  const modules = Object.keys(chunks[0].modules);
  assert(modules.some((id) => id.endsWith("kdbx-native-dom.ts")));
  assert(modules.some((id) => id.includes("kdbxweb/dist/kdbxweb.js")));
  assert(!modules.some((id) => id.includes("@xmldom")));
  return chunks;
}

test(
  "real Chromium native XML preserves encrypted KDBX import and integrity",
  { timeout: 20000 },
  async () => {
    let browser;
    let server;
    try {
      const chunks = await buildProofChunks();
      server = createServer((request, response) => {
        if (request.url === "/proof.mjs") {
          response.writeHead(200, { "content-type": "text/javascript" });
          response.end(chunks[0].code);
        } else {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            '<!doctype html><script type="module" src="/proof.mjs"></script>',
          );
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM || "/usr/bin/chromium",
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage();
      await page.goto(origin);
      const fixture = [
        ...readFileSync(resolve(root, "tests/fixtures/kdbx/roundtrip.kdbx")),
      ];
      const result = await page.evaluate(
        (bytes) => globalThis.runKdbxProof(bytes),
        fixture,
      );
      assert.equal(result.native, true);
      assert.equal(result.magic, 0x9aa2d903);
      assert.equal(result.title, "Native <XML> & Unicode 雪");
      assert.equal(result.protected, true);
      assert.equal(result.secret, "protected-roundtrip");
      assert.equal(result.parsed.items[0].name, result.title);
      assert.equal(result.parsed.items[0].password, result.secret);
      for (const key of [
        "wrongPassword",
        "corruption",
        "importerWrongPassword",
        "importerCorruption",
        "malformedXML",
      ])
        assert.equal(result[key], true, key);
      assert(result.externalCount >= 3);
      assert(result.externalSecrets.includes("fixture-password-one"));
      for (const missing of ["DOMParser", "XMLSerializer"]) {
        const context = await browser.newContext();
        try {
          await context.addInitScript((name) => {
            delete globalThis[name];
          }, missing);
          const unsupported = await context.newPage();
          await unsupported.goto(origin);
          await unsupported.waitForFunction(() => !!globalThis.kdbxSDK);
          const message = await unsupported.evaluate((name) => {
            try {
              if (name === "DOMParser")
                globalThis.kdbxSDK.XmlUtils.parse("<Root/>");
              else
                globalThis.kdbxSDK.XmlUtils.serialize(
                  new DOMParser().parseFromString("<Root/>", "application/xml"),
                );
              return null;
            } catch (error) {
              return String(error);
            }
          }, missing);
          assert.match(
            message,
            new RegExp(`requires a browser document with native ${missing}`),
          );
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
    }
  },
);

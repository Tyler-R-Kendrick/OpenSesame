#!/usr/bin/env node
// Real Chromium WebCrypto + OPFS regression for customer vault segmentation.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "vite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const resolvePageDependency = createRequire(
  path.join(root, "apps/pages/package.json"),
);
const resolveCoreDependency = createRequire(
  path.join(root, "packages/app-core/package.json"),
);
const scratch = await mkdtemp(path.join(tmpdir(), "customer-vault-browser-"));
let browser;
try {
  const entry = path.join(scratch, "entry.ts");
  await writeFile(
    entry,
    `import * as crypto from ${JSON.stringify(path.join(root, "packages/vault-core/src/crypto.ts"))};\nimport * as files from ${JSON.stringify(path.join(root, "packages/vault-core/src/file-parts.ts"))};\nimport * as vaultModel from ${JSON.stringify(path.join(root, "packages/vault-core/src/model.ts"))};\nimport * as vaultPepper from ${JSON.stringify(path.join(root, "packages/vault-core/src/pepper-seal.ts"))};\nimport { SopsEngine } from ${JSON.stringify(path.join(root, "packages/app-core/src/lib/sops/engine.ts"))};\nimport { HandleRegistry } from ${JSON.stringify(path.join(root, "packages/app-core/src/lib/sops/handles.ts"))};\nimport * as plans from ${JSON.stringify(path.join(root, "packages/app-core/src/lib/sops/plan.ts"))};\nimport * as age from ${JSON.stringify(resolvePageDependency.resolve("age-encryption"))};\nimport * as customerSops from ${JSON.stringify(path.join(root, "scripts/test/customer-sops-browser-checks.mjs"))};\nimport * as customerVault from ${JSON.stringify(path.join(root, "scripts/test/customer-vault-browser-checks.mjs"))};\nimport * as browserAtRest from ${JSON.stringify(path.join(root, "packages/browser-at-rest/src/index.ts"))};\nimport * as browserRestChecks from ${JSON.stringify(path.join(root, "scripts/test/customer-at-rest-browser-checks.mjs"))};\nimport * as recordCipher from ${JSON.stringify(path.join(root, "packages/app-core/src/lib/at-rest/cipher.ts"))};\nimport * as recordKeys from ${JSON.stringify(path.join(root, "packages/app-core/src/lib/at-rest/idb-key-store.ts"))};\nimport * as recordHost from ${JSON.stringify(path.join(root, "packages/app-core/src/host.ts"))};\nimport { browserPorts } from ${JSON.stringify(path.join(root, "packages/app-core/src/browser/host.ts"))};\nimport * as vaultBytes from ${JSON.stringify(path.join(root, "packages/vault-core/src/bytes.ts"))};\nimport { xchacha20poly1305 } from ${JSON.stringify(resolveCoreDependency.resolve("@noble/ciphers/chacha"))};\nimport { hkdf } from ${JSON.stringify(resolveCoreDependency.resolve("@noble/hashes/hkdf"))};\nimport { sha256 } from ${JSON.stringify(resolveCoreDependency.resolve("@noble/hashes/sha256"))};\nimport * as recordChecks from ${JSON.stringify(path.join(root, "scripts/test/customer-record-browser-checks.mjs"))};\nObject.assign(globalThis, { vaultModel, vaultPepper, recordCipher, recordKeys, recordHost, browserPortsFactory: browserPorts, vaultBytes, recordPrimitives: { xchacha20poly1305, hkdf, sha256 }, recordChecks, browserAtRest, browserRestChecks, customerSops, customerVault, vaultCrypto: crypto, vaultFiles: files, SopsEngine, HandleRegistry, sopsPlans: plans, age });`,
  );
  await build({
    configFile: false,
    logLevel: "error",
    build: {
      target: "esnext",
      outDir: path.join(scratch, "bundle"),
      lib: {
        entry,
        formats: ["iife"],
        name: "VaultBrowserRegression",
        fileName: () => "vault.js",
      },
    },
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://customer-vault.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Customer vault regression</title>",
    }),
  );
  await page.goto("https://customer-vault.example/");
  await page.addScriptTag({
    content: await readFile(path.join(scratch, "bundle/vault.js"), "utf8"),
  });
  const restChecks = await page.evaluate(() =>
    globalThis.browserRestChecks.verifyBrowserAtRestIsolation("write"),
  );
  const recordChecks = await page.evaluate(() =>
    globalThis.recordChecks.verifyRecordAtRestIsolation("write"),
  );
  const sopsChecks = await page.evaluate(() =>
    globalThis.customerSops.verifySopsCustomerIsolation(),
  );
  const checks = await page.evaluate(() =>
    globalThis.customerVault.verifyCustomerVaultIsolation(),
  );
  await page.reload();
  await page.addScriptTag({
    content: await readFile(path.join(scratch, "bundle/vault.js"), "utf8"),
  });
  restChecks.push(
    ...(await page.evaluate(() =>
      globalThis.browserRestChecks.verifyBrowserAtRestIsolation("reload"),
    )),
  );
  recordChecks.push(
    ...(await page.evaluate(() =>
      globalThis.recordChecks.verifyRecordAtRestIsolation("reload"),
    )),
  );
  await page.evaluate(async () => {
    const directory = await navigator.storage.getDirectory();
    const read = async (name) =>
      new Uint8Array(
        await (
          await (await directory.getFileHandle(name)).getFile()
        ).arrayBuffer(),
      );
    const header = JSON.parse(
      new TextDecoder().decode(await read("customer-a-header")),
    );
    const body = JSON.parse(
      new TextDecoder().decode(await read("customer-a-body")),
    );
    const key = await globalThis.vaultCrypto.unlockVaultKey(
      header,
      "rotated customer A browser password",
    );
    const opened = await globalThis.vaultCrypto.openJson(
      key,
      body,
      globalThis.vaultCrypto.vaultSealBinding("customer-a-vault", "body"),
    );
    const file = await globalThis.vaultFiles.openFile(opened.attachment, [
      { getObject: read },
    ]);
    const account = opened.items.find((item) => item.kind === "account");
    const method = account.methods.find(
      (entry) => entry.id === "peppered-password",
    );
    const nested = await globalThis.vaultPepper.openWithPepper(
      method.sealed,
      "customer A typed pepper",
      globalThis.vaultPepper.pepperBinding(account.id, method.id),
    );
    if (
      opened.items.length !== 10 ||
      account.methods.length !== 7 ||
      nested !== "customer A nested password" ||
      file.bytes.length !== globalThis.vaultFiles.FILE_PART_BYTES + 37 ||
      !file.bytes.every((byte) => byte === 65)
    )
      throw new Error(
        "persisted customer vault and attachment failed after reload",
      );
  });
  checks.push(
    "reloaded browser unlocks persisted customer vault and every OPFS attachment chunk",
  );
  assert.deepEqual(errors, [], "browser page errors");
  console.log(
    JSON.stringify(
      {
        browser: "Chromium",
        checks:
          checks.length +
          sopsChecks.length +
          restChecks.length +
          recordChecks.length,
        passed: [...restChecks, ...recordChecks, ...sopsChecks, ...checks],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await rm(scratch, { recursive: true, force: true });
}

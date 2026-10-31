import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { PACKAGE_RULES } from "../../src/lib/capabilities/classification-packages.js";
import { classifyModule } from "./capability-graph.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const classify = (id) => classifyModule(id, PACKAGE_RULES, { repoRoot: root });

test("owns the real wallet pass protocol package under connectors", () => {
  const names = readdirSync(`${root}/packages/wallet/src`).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  for (const required of [
    "config.ts",
    "google-client.ts",
    "google-class.ts",
    "google-token-reply.ts",
    "payload.ts",
    "provider.ts",
  ])
    assert(
      names.includes(required),
      `Missing real protocol source: ${required}`,
    );
  for (const name of names) {
    const workspace = `${root}/packages/wallet/src/${name}`;
    for (const id of [
      workspace,
      workspace.replaceAll("/", "\\"),
      `${root}/node_modules/@opensesame/wallet/src/${name}`,
      `${root}/node_modules/.pnpm/@opensesame+wallet@0.1.0/node_modules/@opensesame/wallet/src/${name}`,
    ]) {
      const owner = classify(id);
      assert.equal(owner.classification, "optional", id);
      assert.equal(owner.capability, "connectors.external", id);
    }
  }
});

test("keeps ledger and consent ownership and refuses wallet name siblings", () => {
  for (const name of ["wallet-budget", "wallet-consent"]) {
    const owner = classify(`${root}/packages/${name}/src/index.ts`);
    assert.equal(owner.classification, "optional");
    assert.equal(owner.capability, "wallet.spending");
  }
  for (const name of ["wallet-extra", "wallets", "walleting"])
    for (const id of [
      `${root}/packages/${name}/src/config.ts`,
      `${root}/node_modules/@opensesame/${name}/src/config.ts`,
    ]) {
      const owner = classify(id);
      assert.equal(owner.capability, null, id);
      assert.notEqual(owner.classification, "optional", id);
    }
});

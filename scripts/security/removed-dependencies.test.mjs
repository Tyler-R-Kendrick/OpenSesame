import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../node_modules/.pnpm/node_modules/", import.meta.url),
);
const { parse } = require("yaml");
const removed = new Set(["braces", "node-forge", "jks-js"]);
const lock = parse(
  readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
);

function assertAllowedReference(reference) {
  if (typeof reference !== "string") return;
  for (const name of removed) {
    assert.ok(
      !reference.startsWith(`${name}@`),
      `Removed dependency alias: ${reference}`,
    );
  }
}

test("removed vulnerable devtools dependencies have no packages, snapshots or consumer edges", () => {
  assert.equal(lock.lockfileVersion, "9.0");
  for (const section of [
    lock.packages,
    lock.snapshots,
    lock.patchedDependencies ?? {},
  ]) {
    assert.ok(section && typeof section === "object");
    for (const name of Object.keys(section)) assertAllowedReference(name);
  }
  for (const consumer of [
    ...Object.values(lock.importers),
    ...Object.values(lock.snapshots),
  ]) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const [name, entry] of Object.entries(consumer[field] ?? {})) {
        assert.ok(!removed.has(name), `Removed dependency edge: ${name}`);
        assertAllowedReference(
          typeof entry === "string" ? entry : entry.version,
        );
      }
    }
  }
});

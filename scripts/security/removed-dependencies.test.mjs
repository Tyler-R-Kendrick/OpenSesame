import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isString } from "../lib/json-boundary.mjs";

const removed = new Set(["braces", "node-forge", "jks-js"]);
const lock = JSON.parse(
  readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
);

function packageName(key) {
  const parts = key.split("node_modules/");
  return parts.length > 1 ? parts.at(-1) : undefined;
}

function assertAllowedReference(reference) {
  if (!isString(reference)) return;
  for (const name of removed) {
    assert.ok(
      !reference.startsWith(`${name}@`) && reference !== name,
      `Removed dependency alias: ${reference}`,
    );
  }
}

test("removed vulnerable devtools dependencies have no lockfile edges", () => {
  assert.ok(lock.lockfileVersion >= 3);
  const packages = lock.packages ?? {};
  assert.equal(typeof packages, "object");
  for (const [key, entry] of Object.entries(packages)) {
    const name = packageName(key);
    if (name !== undefined) {
      assert.ok(!removed.has(name), `Removed dependency package: ${key}`);
    }
    if (isString(entry?.name)) {
      assert.ok(!removed.has(entry.name), `Removed dependency name: ${entry.name}`);
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const dep of Object.keys(entry?.[field] ?? {})) {
        assert.ok(!removed.has(dep), `Removed dependency edge: ${dep}`);
        assertAllowedReference(dep);
      }
    }
  }
});

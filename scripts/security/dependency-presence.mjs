import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "../lib/json-boundary.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(
  new URL("../../node_modules/.pnpm/node_modules/", import.meta.url),
);
const { parse } = require("yaml");
const lockfile = (root) =>
  parse(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"));
const family = (name, prefix) => `${name}@${prefix}`;

export function dependencyPresent(name, prefix = "", root = repository) {
  const lock = lockfile(root);
  assert.ok(
    lock.packages && lock.snapshots && lock.importers,
    "Complete dependency lock required",
  );
  return Object.keys(lock.packages).some((key) =>
    key.startsWith(family(name, prefix)),
  );
}

/** An omitted family is checked, not reported as a successful attack regression. */
export function assertDependencyAbsent(name, prefix = "", root = repository) {
  const lock = lockfile(root);
  assert.equal(
    dependencyPresent(name, prefix, root),
    false,
    "Dependency package reappeared",
  );
  assert.ok(
    !Object.keys(lock.snapshots).some((key) =>
      key.startsWith(family(name, prefix)),
    ),
    "Dependency snapshot reappeared",
  );
  for (const consumer of [
    ...Object.values(lock.importers),
    ...Object.values(lock.snapshots),
  ]) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const [dependency, entry] of Object.entries(consumer[field] ?? {})) {
        const reference = isString(entry) ? entry : entry.version;
        assert.ok(isString(reference), "Dependency reference must be explicit");
        const qualified =
          dependency === name ? `${name}@${reference}` : reference;
        assert.ok(
          !qualified.startsWith(family(name, prefix)) &&
            !qualified.includes(`npm:${family(name, prefix)}`),
          "Dependency edge reappeared",
        );
      }
    }
  }
  const manifest = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  assert.ok(
    !Object.keys(manifest.pnpm?.patchedDependencies ?? {}).some((key) =>
      key.startsWith(family(name, prefix)),
    ),
    "Unused backport declaration reappeared",
  );
}

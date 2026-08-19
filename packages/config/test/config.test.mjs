import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

test("tsconfig.base.json extends repo root and is strict-friendly", () => {
  const raw = JSON.parse(
    readFileSync(join(root, "..", "tsconfig.base.json"), "utf8"),
  );
  assert.equal(raw.extends, "../../tsconfig.base.json");
});

test("tsconfig.library.json is NodeNext-ready via base", () => {
  const raw = JSON.parse(
    readFileSync(join(root, "..", "tsconfig.library.json"), "utf8"),
  );
  assert.equal(raw.extends, "./tsconfig.base.json");
  assert.equal(raw.compilerOptions.noEmit, true);
});

test("property: repo root tsconfig is strict", () => {
  const raw = JSON.parse(
    readFileSync(join(root, "..", "..", "..", "tsconfig.base.json"), "utf8"),
  );
  assert.equal(raw.compilerOptions.strict, true);
  assert.equal(raw.compilerOptions.exactOptionalPropertyTypes, true);
  assert.equal(raw.compilerOptions.noUncheckedIndexedAccess, true);
});

test("adversarial: shared base does not disable strictness", () => {
  const raw = JSON.parse(
    readFileSync(join(root, "..", "tsconfig.base.json"), "utf8"),
  );
  assert.equal(raw.extends, "../../tsconfig.base.json");
  assert.equal(raw.compilerOptions.strict, undefined);
});

test("chaos: missing tsconfig files fail the typecheck script contract", () => {
  const base = join(root, "..", "tsconfig.base.json");
  const library = join(root, "..", "tsconfig.library.json");
  assert.equal(existsSync(base), true);
  assert.equal(existsSync(library), true);
});

test("contract: package exports only tsconfig JSON", () => {
  const pkg = JSON.parse(
    readFileSync(join(root, "..", "package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(pkg.exports), [
    "./tsconfig.base.json",
    "./package.json",
  ]);
});

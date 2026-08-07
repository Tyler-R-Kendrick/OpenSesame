import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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

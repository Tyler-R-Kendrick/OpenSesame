import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertDependencyAbsent,
  dependencyPresent,
} from "./dependency-presence.mjs";

function fixture(lock, inspect) {
  const root = mkdtempSync(join(tmpdir(), "absent-dependency-control-"));
  try {
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), JSON.stringify(lock));
    inspect(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a genuinely absent package is distinct from any unpatched reappearance", () => {
  fixture({ packages: {}, snapshots: {}, importers: {} }, (root) => {
    assert.equal(dependencyPresent("braces", "", root), false);
    assertDependencyAbsent("braces", "", root);
  });
  fixture(
    { packages: { "braces@3.0.3": {} }, snapshots: {}, importers: {} },
    (root) => {
      assert.equal(dependencyPresent("braces", "", root), true);
      assert.throws(
        () => assertDependencyAbsent("braces", "", root),
        /reappeared/,
      );
    },
  );
});

test("raw, aliased and orphan snapshot references cannot satisfy absence", () => {
  for (const edge of ["braces@3.0.3", "npm:braces@3.0.3"]) {
    fixture(
      {
        packages: {},
        snapshots: {},
        importers: { ".": { dependencies: { alias: { version: edge } } } },
      },
      (root) => {
        assert.throws(
          () => assertDependencyAbsent("braces", "", root),
          /edge reappeared/,
        );
      },
    );
  }
  fixture(
    { packages: {}, snapshots: { "braces@3.0.3": {} }, importers: {} },
    (root) => {
      assert.throws(
        () => assertDependencyAbsent("braces", "", root),
        /snapshot reappeared/,
      );
    },
  );
});

test("major-specific absence preserves an installed newer family and rejects a raw old edge", () => {
  fixture(
    {
      packages: { "js-yaml@5.4.3": {} },
      snapshots: { "js-yaml@5.4.3": {} },
      importers: {},
    },
    (root) => {
      assertDependencyAbsent("js-yaml", "3.", root);
    },
  );
  fixture(
    {
      packages: {},
      snapshots: {},
      importers: {
        ".": { dependencies: { "js-yaml": { version: "3.15.2" } } },
      },
    },
    (root) => {
      assert.throws(
        () => assertDependencyAbsent("js-yaml", "3.", root),
        /edge reappeared/,
      );
    },
  );
});

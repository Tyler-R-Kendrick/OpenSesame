import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { inspectPhantomImport } from "./phantom-import-evidence.mjs";

function inspect(source) {
  const root = mkdtempSync(join(tmpdir(), "phantom-import-"));
  try {
    writeFileSync(join(root, "fixture.mjs"), source);
    return inspectPhantomImport(root, "fixture-package", "fixture.mjs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("real import, reexport, dynamic import and require remain real imports", () => {
  for (const source of [
    'import value from "fixture-package";',
    'export { value } from "fixture-package/subpath";',
    'const value = await import("fixture-package");',
    'const value = require("fixture-package");',
    'const path = require.resolve("fixture-package/subpath");',
    'import value = require("fixture-package");',
  ])
    assert.equal(inspect(source), "actual_import");
});

test("fake source literals are distinguished without executing source", () => {
  assert.equal(
    inspect(
      'const files = new Map([["fixture.ts", \'import { value } from "fixture-package";\']]);',
    ),
    "literal_fixture",
  );
  assert.equal(
    inspect(
      'const source = `const x = await import("fixture-package/subpath");`;',
    ),
    "literal_fixture",
  );
});

test("real import wins over a fixture literal in the same file", () => {
  assert.equal(
    inspect(
      'import x from "fixture-package"; const source = \'import y from "fixture-package";\';',
    ),
    "actual_import",
  );
});

test("unsupported or mismatched diagnostics fail closed", () => {
  for (const source of [
    "const source = 'import(\"fixture-package\")'; eval(source);",
    "const source = 'import(\"fixture-package\")'; new Function(source);",
    "const source = 'import(\"fixture-package\")'; vm.runInNewContext(source);",
    'const text = "fixture-package";',
    'import x from "different-package";',
    'const x = loader("fixture-package");',
    "eval('import(\"fixture-package\")');",
    "const source = 'import x from \"fixture-package\";'; import(variable);",
    "const source = 'import x from \"fixture-package\";'; const broken = ;",
  ])
    assert.equal(inspect(source), "unresolved_diagnostic");
});

test("missing and escaping source files fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "phantom-import-root-"));
  const outside = mkdtempSync(join(tmpdir(), "phantom-import-outside-"));
  try {
    writeFileSync(
      join(outside, "source.mjs"),
      'import x from "fixture-package";',
    );
    symlinkSync(join(outside, "source.mjs"), join(root, "escape.mjs"), "file");
    assert.equal(
      inspectPhantomImport(root, "fixture-package", "missing.mjs"),
      "unresolved_diagnostic",
    );
    assert.equal(
      inspectPhantomImport(root, "fixture-package", "escape.mjs"),
      "unresolved_diagnostic",
    );
    assert.equal(
      inspectPhantomImport(
        root,
        "fixture-package",
        join(outside, "source.mjs"),
      ),
      "unresolved_diagnostic",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

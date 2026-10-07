import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { inspectPhantomImport } from "./phantom-import-evidence.mjs";

function inspect(source, name = "fixture-package") {
  const root = mkdtempSync(join(tmpdir(), "phantom-import-"));
  try {
    writeFileSync(join(root, "fixture.mjs"), source);
    return inspectPhantomImport(root, name, "fixture.mjs");
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

const diagnostic = `tsyringe requires a reflect polyfill. Please add 'import "reflect-metadata"' to the top of your entry point.`;
const reflectSource = `Symbol.for("@reflect-metadata:registry"); if (!Reflect.getMetadata) throw new Error(${JSON.stringify(diagnostic)});`;
test("exact upstream reflect diagnostics are literal diagnostics, not imports", () => {
  assert.equal(
    inspect(reflectSource, "reflect-metadata"),
    "literal_diagnostic",
  );
  assert.equal(
    inspect(`import "reflect-metadata"; ${reflectSource}`, "reflect-metadata"),
    "actual_import",
  );
  assert.equal(inspect(reflectSource, "other"), "unresolved_diagnostic");
});
test("shadowed or assigned Error/Symbol cannot attest a built-in diagnostic", () => {
  for (const prefix of [
    "const Error = custom;",
    "function Error() {}",
    "class Error {}",
    'import Error from "custom";',
    "Error = custom;",
    "const { Error } = custom;",
    "const Symbol = custom;",
    "function Symbol() {}",
    "class Symbol {}",
    'import Symbol from "custom";',
    "Symbol = custom;",
    "const { Symbol } = custom;",
    "Symbol.for = custom;",
    "Error.prototype = custom;",
  ]) {
    assert.equal(
      inspect(`${prefix}${reflectSource}`, "reflect-metadata"),
      "unresolved_diagnostic",
      prefix,
    );
  }
  for (const name of ["Error", "Symbol"])
    assert.equal(
      inspect(
        `try {} catch (${name}) { ${reflectSource} }`,
        "reflect-metadata",
      ),
      "unresolved_diagnostic",
    );
});
test("altered diagnostic, nonthrow construction, extra arguments and executable sources refuse", () => {
  for (const source of [
    reflectSource.replace("polyfill.", "polyfill!"),
    `new Error(${JSON.stringify(diagnostic)});`,
    `throw Error(${JSON.stringify(diagnostic)});`,
    `throw new CustomError(${JSON.stringify(diagnostic)});`,
    `throw new Error(${JSON.stringify(diagnostic)}, options);`,
    `${reflectSource} eval(source);`,
    `${reflectSource} new Function(source);`,
    `${reflectSource} vm.runInNewContext(source);`,
    `${reflectSource} import(variable);`,
    `${reflectSource} arbitrary("reflect-metadata");`,
    reflectSource.replace("Symbol.for", "custom.for"),
  ])
    assert.equal(
      inspect(source, "reflect-metadata"),
      "unresolved_diagnostic",
      source,
    );
});

test("only exact constant unshadowed Function global getter is non-importing", () => {
  for (const call of [
    'Function("return this;")',
    "new Function(`return this;`)",
  ]) {
    const source = `${reflectSource} ${call};`;
    assert.equal(inspect(source, "reflect-metadata"), "literal_diagnostic");
    assert.equal(
      inspect(`import "reflect-metadata"; ${source}`, "reflect-metadata"),
      "actual_import",
    );
  }
  for (const call of [
    'Function("return globalThis;")',
    'Function("return this")',
    'Function("x", "return this;")',
    "Function(`return ${value};`)",
    'Function("return " + "this;")',
    "Function(source)",
    'Alias("return this;")',
    'eval("return this;")',
    'vm.runInNewContext("return this;")',
  ]) {
    const prefix = call.startsWith("Alias") ? "const Alias = Function;" : "";
    assert.equal(
      inspect(`${prefix}${reflectSource} ${call};`, "reflect-metadata"),
      "unresolved_diagnostic",
      call,
    );
  }
  for (const prefix of [
    "const Function = custom;",
    "function Function() {}",
    "class Function {}",
    'import Function from "custom";',
    "Function = custom;",
    "const { Function } = custom;",
    "globalThis.Function = custom;",
  ]) {
    assert.equal(
      inspect(
        `${prefix}${reflectSource} Function("return this;");`,
        "reflect-metadata",
      ),
      "unresolved_diagnostic",
      prefix,
    );
  }
  assert.equal(
    inspect(
      `try {} catch (Function) { ${reflectSource} Function("return this;"); }`,
      "reflect-metadata",
    ),
    "unresolved_diagnostic",
  );
});

test("computed global writes and deletions cannot attest built-in diagnostics", () => {
  for (const prefix of [
    "globalThis['Error'] = custom;",
    "window['Symbol']['for'] = custom;",
    "globalThis['Function'] = custom;",
    "delete globalThis.Error;",
    "delete Symbol.for;",
    "delete globalThis.Function;",
    "globalThis[key] = custom;",
    "Object = custom;",
  ]) {
    assert.equal(
      inspect(
        `${prefix}${reflectSource} Function("return this;");`,
        "reflect-metadata",
      ),
      "unresolved_diagnostic",
      prefix,
    );
  }
});

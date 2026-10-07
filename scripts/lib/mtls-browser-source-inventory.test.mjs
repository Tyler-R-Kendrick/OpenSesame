import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkflowFixtureIsTestOnly,
  shippedSources,
} from "../mtls/browser-source-inventory.mjs";

const fixture =
  "packages/app-core/src/lib/vault/password-workflows.test-support.ts";
const roots = [];
function repository() {
  const root = mkdtempSync(join(tmpdir(), "mtls-browser-inventory-"));
  roots.push(root);
  put(root, fixture, 'import { readFile } from "node:fs/promises";');
  return root;
}
function put(root, path, source) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("mTLS shipped-source inventory", () => {
  it("admits the proven fixture only through test importers", () => {
    const root = repository();
    put(
      root,
      "packages/app-core/src/lib/vault/workflow.test.ts",
      'import "./password-workflows.test-support.js";',
    );
    expect(assertWorkflowFixtureIsTestOnly(root)).toHaveLength(1);
    expect(shippedSources(root, "packages/app-core")).toEqual([]);
  });

  it.each([
    'import "./password-workflows.test-support.js";',
    'import "./password-workflows.test-support.ts";',
    'import "./password-workflows.test-support";',
    'export * from "./password-workflows.test-support.js";',
    'import("./password-workflows.test-support.js");',
    'require("./password-workflows.test-support.js");',
    'import "./password-workflows.test\\u002dsupport.js";',
  ])("refuses a production fixture edge: %s", (source) => {
    const root = repository();
    put(root, "packages/app-core/src/lib/vault/production.ts", source);
    expect(() => shippedSources(root, "packages/app-core")).toThrow(
      "Test-only workflow fixture imported by production",
    );
  });

  it("refuses the exported package alias from an application", () => {
    const root = repository();
    put(
      root,
      "apps/pages/src/production.ts",
      'import "@opensesame/app-core/lib/vault/password-workflows.test-support.js";',
    );
    expect(() => shippedSources(root, "packages/app-core")).toThrow(
      "apps/pages/src/production.ts",
    );
  });

  it.each(["runner", "lib"])(
    "refuses a shipped extension %s importer reached by its entrypoint",
    (directory) => {
      const root = repository();
      put(
        root,
        "apps/browser-extension/entrypoints/background.ts",
        `import "../${directory}/security-listener";`,
      );
      const importer = `apps/browser-extension/${directory}/security-listener.ts`;
      put(
        root,
        importer,
        'import "@opensesame/app-core/lib/vault/password-workflows.test-support.js";',
      );
      expect(() => shippedSources(root, "packages/app-core")).toThrow(importer);
    },
  );

  it("retains unrelated support files and production native imports", () => {
    const root = repository();
    put(
      root,
      "packages/app-core/src/other.test-support.ts",
      'import "node:fs";',
    );
    put(root, "packages/app-core/src/production.ts", 'import "node:net";');
    expect(shippedSources(root, "packages/app-core")).toEqual([
      "src/other.test-support.ts",
      "src/production.ts",
    ]);
  });

  it("does not confuse a comment with an actual fixture import", () => {
    const root = repository();
    put(
      root,
      "packages/app-core/src/production.ts",
      '// import "./lib/vault/password-workflows.test-support.js";',
    );
    expect(assertWorkflowFixtureIsTestOnly(root)).toEqual([]);
    expect(shippedSources(root, "packages/app-core")).toEqual([
      "src/production.ts",
    ]);
  });
});

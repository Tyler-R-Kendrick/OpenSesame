import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HUB_TESTS,
  isInfraPath,
  planUnitTests,
  reverseImports,
  testsReaching,
  vitestScript,
} from "./ci-scoped-tests.mjs";

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "scoped-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const pkg = (test) => JSON.stringify({ name: "@t/a", scripts: { test } });
const nodes = [{ name: "@t/a", dir: "packages/a" }];
const plan = (root, paths) =>
  planUnitTests({
    root,
    nodes,
    packages: ["@t/a"],
    paths,
    isDoc: (path) => path.endsWith(".md"),
  })[0];

describe("ci scoped tests", () => {
  it("reads a plain vitest script and the chain after it", () => {
    expect(vitestScript("vitest run")).toEqual({ rest: undefined });
    expect(vitestScript("vitest run --maxWorkers=4 && node --test x")).toEqual({
      rest: "node --test x",
    });
    expect(vitestScript("tsx run.ts")).toBeNull();
  });

  it("treats manifests, configs and lockfiles as infrastructure", () => {
    for (const path of [
      "packages/a/package.json",
      "pnpm-lock.yaml",
      "packages/a/tsconfig.json",
      "packages/a/vitest.config.ts",
      "packages/a/vite.config.ts",
    ]) {
      expect(isInfraPath(path), path).toBe(true);
    }
    expect(isInfraPath("packages/a/src/x.ts")).toBe(false);
  });

  it("runs the whole suite when the script is not plain vitest or infrastructure changed", () => {
    const root = repo({
      "packages/a/package.json": pkg("node run.mjs"),
      "packages/a/src/x.ts": "export const x = 1;\n",
    });
    expect(plan(root, ["packages/a/src/x.ts"]).mode).toBe("full");
    const plain = repo({
      "packages/a/package.json": pkg("vitest run"),
      "packages/a/vitest.config.ts": "export default {};\n",
      "packages/a/src/x.ts": "export const x = 1;\n",
    });
    expect(plan(plain, ["packages/a/package.json"]).mode).toBe("full");
    expect(plan(plain, ["packages/a/src/x.ts"]).mode).toBe("scoped");
  });

  it("runs the whole suite when a changed file is imported by the test setup", () => {
    const root = repo({
      "packages/a/package.json": pkg("vitest run"),
      "packages/a/vitest.config.ts":
        'export default { test: { setupFiles: ["./src/setup.ts"] } };\n',
      "packages/a/src/setup.ts": 'import "./shared.js";\n',
      "packages/a/src/shared.ts": "export {};\n",
    });
    const entry = plan(root, ["packages/a/src/shared.ts"]);
    expect(entry.mode).toBe("full");
    expect(entry.why).toContain("setup");
  });

  it("always names the tests that read the filesystem, and skips deleted files", () => {
    const root = repo({
      "packages/a/package.json": pkg("vitest run"),
      "packages/a/src/x.ts": "export const x = 1;\n",
      "packages/a/src/ledger.test.ts":
        'import { readFileSync } from "node:fs";\n',
      "packages/a/src/x.test.ts": 'import "./x.js";\n',
    });
    const entry = plan(root, ["packages/a/src/x.ts", "packages/a/src/gone.ts"]);
    expect(entry.structural).toEqual(["src/ledger.test.ts"]);
    expect(entry.related).toEqual(["packages/a/src/x.ts"]);
  });

  it("follows a hub's tests a few steps, not the whole suite", () => {
    const files = {
      "packages/a/package.json": pkg("vitest run"),
      "packages/a/src/hub.ts": "export const hub = 1;\n",
      "packages/a/src/near.ts": 'import { hub } from "./hub.js";\n',
      "packages/a/src/near.test.ts": 'import "./near.js";\n',
    };
    for (let i = 0; i < HUB_TESTS + 1; i += 1) {
      files[`packages/a/src/mid${i}.ts`] = 'import "./near.js";\n';
      files[`packages/a/src/mid${i}.test.ts`] = `import "./mid${i}.js";\n`;
    }
    files["packages/a/src/direct.test.ts"] = 'import "./hub.js";\n';
    const root = repo(files);
    const entry = plan(root, ["packages/a/src/hub.ts"]);
    expect(entry.hubs).toEqual(["packages/a/src/hub.ts"]);
    expect(entry.related).toEqual([]);
    expect(entry.hubTests).toContain("src/direct.test.ts");
    expect(entry.hubTests).toContain("src/near.test.ts");
    expect(entry.hubTests.length).toBeLessThan(HUB_TESTS);
    const reverse = reverseImports(root, nodes);
    expect(
      testsReaching(reverse, "packages/a/src/hub.ts", "packages/a").size,
    ).toBeGreaterThan(HUB_TESTS);
  });

  it("maps a snapshot to its test", () => {
    const root = repo({
      "packages/a/package.json": pkg("vitest run"),
      "packages/a/src/x.test.ts": "export {};\n",
    });
    expect(
      plan(root, ["packages/a/src/__snapshots__/x.test.ts.snap"]).related,
    ).toEqual(["packages/a/src/x.test.ts"]);
  });
});

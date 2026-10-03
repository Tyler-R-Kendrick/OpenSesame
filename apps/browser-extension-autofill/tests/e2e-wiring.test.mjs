import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The browser end-to-end suite (`e2e/`) is wired into the repository's e2e
// aggregation and nowhere else: `pnpm test` needs no browser, no port and no
// build. This runs in `pnpm test` and reads files only.
const here = dirname(fileURLToPath(import.meta.url));
const companion = join(here, "..");
const root = join(companion, "../..");
const json = (...parts) => JSON.parse(readFileSync(join(...parts), "utf8"));

const pkg = json(companion, "package.json");

test("the default test script needs no browser", () => {
  // (`tests/e2e-wiring.test.mjs` is this file; `e2e/` is the browser suite.)
  assert.doesNotMatch(
    pkg.scripts.test,
    /(^|\s)e2e\/|test:e2e|playwright|wxt build/,
  );
});

test("test:e2e builds the extension it is about to load, then runs every suite one at a time", () => {
  const script = pkg.scripts["test:e2e"];
  assert.ok(
    script.startsWith("wxt build && "),
    "the suite loads the build, never a stale one",
  );
  // The stub daemon binds the one port the extension is built to call.
  assert.match(script, /--test-concurrency=1/);
  assert.match(script, /e2e\/\*\.e2e\.mjs/);
  const suites = readdirSync(join(companion, "e2e")).filter((file) =>
    file.endsWith(".e2e.mjs"),
  );
  assert.ok(suites.length >= 3, `suites found: ${suites.join(", ")}`);
});

test("the Playwright it drives is the version the repository pins", () => {
  const rootPkg = json(root, "package.json");
  const pinned = { ...rootPkg.dependencies, ...rootPkg.devDependencies }[
    "@playwright/test"
  ];
  assert.equal(pkg.devDependencies["@playwright/test"], pinned);
});

test("turbo runs it under test:e2e and hands it the browser path", () => {
  const task = json(root, "turbo.json").tasks["test:e2e"];
  assert.ok(task, "test:e2e is a turbo task");
  assert.ok(task.env.includes("PLAYWRIGHT_CHROMIUM"));
  assert.equal(task.cache, false);
});

test("the suites drive the shipped bundle, not the sources behind it", () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith(".mjs")
          ? [join(dir, entry.name)]
          : [],
    );
  for (const file of walk(join(companion, "e2e"))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'](\.\.\/)+(lib|entrypoints)\//,
      `${file} imports source`,
    );
  }
});

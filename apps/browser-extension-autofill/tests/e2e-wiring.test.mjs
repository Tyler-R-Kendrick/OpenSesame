import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readyWorker } from "../e2e/harness/worker.mjs";

// The browser end-to-end suite (`e2e/`) is wired into the repository's e2e
// aggregation and nowhere else: `pnpm test` needs no browser, no port and no
// build. This runs in `pnpm test` and reads files only.
const here = dirname(fileURLToPath(import.meta.url));
const companion = join(here, "..");
const root = join(companion, "../..");
const json = (...parts) => JSON.parse(readFileSync(join(...parts), "utf8"));

const pkg = json(companion, "package.json");

test("worker discovery waits for extension bindings and ignores page workers", async () => {
  let polls = 0;
  const reads = [];
  const unrelated = {
    url: () => "http://app.test/sw.js",
    evaluate: () => assert.fail("page worker must not be selected"),
  };
  const extension = {
    url: () => "chrome-extension://test/background.js",
    evaluate: async (probe) => {
      // Run the real probe against the early CDP global, then ready bindings.
      const previous = globalThis.chrome;
      globalThis.chrome =
        polls < 2
          ? {}
          : {
              runtime: { getURL: () => "chrome-extension://test/" },
              storage: {
                local: {
                  get: async (keys) => {
                    reads.push(["local", keys]);
                    return {};
                  },
                },
                session: {
                  get: async (keys) => {
                    reads.push(["session", keys]);
                    return {};
                  },
                },
              },
              scripting: { getRegisteredContentScripts() {} },
            };
      try {
        return await probe();
      } finally {
        globalThis.chrome = previous;
      }
    },
  };
  assert.equal(
    await readyWorker(
      { serviceWorkers: () => [unrelated, extension] },
      {
        attempts: 3,
        pause: async () => {
          polls++;
        },
      },
    ),
    extension,
  );
  assert.equal(polls, 2);
  assert.deepEqual(reads, [
    ["local", []],
    ["session", []],
  ]);
});

test("worker readiness handles replacement and fails closed if APIs stay absent", async () => {
  const stopped = {
    url: () => "chrome-extension://test/background.js",
    evaluate: async () => {
      throw new Error("worker stopped");
    },
  };
  const replacement = { ...stopped, evaluate: async () => true };
  let current = stopped;
  assert.equal(
    await readyWorker(
      { serviceWorkers: () => [current] },
      {
        attempts: 2,
        pause: async () => {
          current = replacement;
        },
      },
    ),
    replacement,
  );
  await assert.rejects(
    readyWorker(
      { serviceWorkers: () => [stopped] },
      {
        attempts: 2,
        pause: async () => {},
      },
    ),
    /extension worker APIs did not become ready/,
  );
});

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

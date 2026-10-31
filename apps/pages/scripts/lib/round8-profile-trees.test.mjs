import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { listNodeModules, mirrorNodeModules } from "./round8-profile-trees.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "round8-trees-"));
}

function writeJson(root, file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
}

/** The workspace sources a worktree has before anything is installed. */
function sources(root) {
  writeJson(root, "apps/pages/package.json", { name: "@opensesame/pages" });
  writeJson(root, "packages/app-core/package.json", {
    name: "@opensesame/app-core",
    exports: { "./*.js": "./src/*.ts" },
  });
  fs.mkdirSync(path.join(root, "packages/app-core/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages/app-core/src/host.ts"), "");
  return root;
}

/** vite installed at `at` (a node_modules directory under `root`). */
function installVite(root, at) {
  writeJson(root, `${at}/vite/package.json`, {
    name: "vite",
    main: "index.js",
  });
  fs.writeFileSync(path.join(root, at, "vite/index.js"), "");
}

/** app-core linked into `at`, relatively, as a workspace install links it. */
function linkAppCore(root, at) {
  const scope = path.join(root, at, "@opensesame");
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(
    path.relative(scope, path.join(root, "packages/app-core")),
    path.join(scope, "app-core"),
  );
}

const resolvesInside = (root) =>
  fs.realpathSync(path.join(root, "packages/app-core"));

test("listNodeModules finds the outer node_modules only", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "apps/pages/node_modules"), {
    recursive: true,
  });
  fs.mkdirSync(
    path.join(root, "packages/one/node_modules/inner/node_modules"),
    {
      recursive: true,
    },
  );
  const found = listNodeModules(root).map((abs) => path.relative(root, abs));
  assert.deepEqual(found.sort(), [
    "apps/pages/node_modules",
    "packages/one/node_modules",
  ]);
});

test("a tree whose pages already resolve vite inside it is left alone", () => {
  const from = sources(tempRoot());
  const to = sources(tempRoot());
  installVite(to, "node_modules");
  installVite(from, "node_modules");
  fs.writeFileSync(path.join(from, "node_modules/vite/extra.js"), "");
  mirrorNodeModules(from, to);
  assert.deepEqual(fs.readdirSync(path.join(to, "node_modules/vite")).sort(), [
    "index.js",
    "package.json",
  ]);
});

test("a hoisted install mirrors, and app-core resolves inside the copy", () => {
  const from = sources(tempRoot());
  installVite(from, "node_modules");
  linkAppCore(from, "node_modules");
  const to = sources(tempRoot());
  mirrorNodeModules(from, to);
  assert.ok(fs.existsSync(path.join(to, "node_modules/vite/package.json")));
  assert.equal(
    fs.realpathSync(path.join(to, "node_modules/@opensesame/app-core")),
    resolvesInside(to),
  );
});

test("an isolated install mirrors the member's own node_modules too", () => {
  const from = sources(tempRoot());
  installVite(from, "apps/pages/node_modules");
  linkAppCore(from, "apps/pages/node_modules");
  const to = sources(tempRoot());
  mirrorNodeModules(from, to);
  assert.equal(
    fs.realpathSync(
      path.join(to, "apps/pages/node_modules/@opensesame/app-core"),
    ),
    resolvesInside(to),
  );
});

test("a workspace package that resolves outside the copy is refused", () => {
  const from = sources(tempRoot());
  installVite(from, "node_modules");
  const scope = path.join(from, "node_modules/@opensesame");
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(
    path.join(from, "packages/app-core"),
    path.join(scope, "app-core"),
  );
  const to = sources(tempRoot());
  assert.throws(
    () => mirrorNodeModules(from, to),
    /workspace packages must resolve inside/,
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { listNodeModules, mirrorNodeModules } from "./round8-profile-trees.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "round8-trees-"));
}

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

test("a tree whose marker exists is left alone", () => {
  const from = tempRoot();
  const to = tempRoot();
  const marker = path.join(to, "apps/pages/node_modules/vite/package.json");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "{}");
  fs.mkdirSync(path.join(from, "apps/pages/node_modules/vite"), {
    recursive: true,
  });
  mirrorNodeModules(from, to);
  const copied = path.join(to, "apps/pages/node_modules/vite");
  assert.deepEqual(fs.readdirSync(copied), ["package.json"]);
});

test("an absolute workspace link is refused after the copy", () => {
  const from = tempRoot();
  const to = tempRoot();
  const scopeDir = path.join(from, "node_modules/@opensesame");
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.mkdirSync(path.join(from, "real-app-core"), { recursive: true });
  fs.symlinkSync(
    path.join(from, "real-app-core"),
    path.join(scopeDir, "app-core"),
  );
  const pagesScope = path.join(from, "apps/pages/node_modules/@opensesame");
  fs.mkdirSync(pagesScope, { recursive: true });
  fs.symlinkSync(
    path.join(from, "real-app-core"),
    path.join(pagesScope, "app-core"),
  );
  fs.mkdirSync(path.join(from, "apps/pages/node_modules/vite"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(from, "apps/pages/node_modules/vite/package.json"),
    "{}",
  );
  assert.throws(
    () => mirrorNodeModules(from, to),
    /workspace link must stay relative/,
  );
});

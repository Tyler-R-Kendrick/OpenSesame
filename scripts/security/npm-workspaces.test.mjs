import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const patches = {
  "js-yaml@3.15.2": "patches/js-yaml@3.15.2.patch",
  "@simple-git/argv-parser@2.0.1":
    "patches/@simple-git__argv-parser@2.0.1.patch",
  "@devicefarmer/adbkit@3.3.8": "patches/@devicefarmer__adbkit@3.3.8.patch",
  "@levischuck/tiny-cbor@0.2.11":
    "patches/@levischuck__tiny-cbor@0.2.11.patch",
};

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function workspaceGlobs(yaml) {
  return [...yaml.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((match) => match[1]);
}

test("npm workspaces replace the pnpm lockfile", () => {
  assert.equal(existsSync(join(root, "pnpm-lock.yaml")), false);
  assert.equal(existsSync(join(root, "package-lock.json")), true);
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(Object.hasOwn(manifest, "packageManager"), false);
  assert.equal(Object.hasOwn(manifest, "pnpm"), false);
  assert.equal(manifest.engines.node, ">=24");
  assert.equal(typeof manifest.devDependencies.turbo, "string");
  assert.ok(lock.lockfileVersion >= 3);
  assert.equal(lock.packages[""].name, "opensesame");
  const former = workspaceGlobs(read("pnpm-workspace.yaml"));
  assert.deepEqual(manifest.workspaces, former);
  assert.deepEqual(former, [
    "apps/*",
    "packages/*",
    "examples/*",
    "tests/redteam",
    "tests/visual-contract",
    "tests/fuzz/jazzer",
    "tools/mock-upstream-idp",
    "tools/oxlint/anti-slop",
  ]);
});

test("patched dependencies are referenced from patchedDependencies", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.deepEqual(manifest.patchedDependencies, patches);
  // npm rejects the patch: URL protocol (EUNSUPPORTEDPROTOCOL). Version pins
  // keep the patched releases installed; patchedDependencies names the files.
  const overrides = manifest.overrides;
  assert.equal(JSON.stringify(overrides).includes("patch:"), false);
  assert.equal(overrides["js-yaml@^3"], "3.15.2");
  assert.equal(overrides["js-yaml@3.15.2"].argparse, "2.0.1");
  assert.equal(overrides["@simple-git/argv-parser"], "2.0.1");
  assert.equal(overrides["@devicefarmer/adbkit"]["."], "3.3.8");
  assert.equal(overrides["@devicefarmer/adbkit"]["node-forge"], "-");
  assert.equal(overrides.promptfoo["jks-js"], "-");
  assert.equal(overrides.promptfoo["@huggingface/transformers"], "-");
  // chokidar 3 pulls braces. The removed-dependencies gate forbids braces,
  // and the previous pnpm tree only resolved chokidar 5.
  assert.equal(overrides["chokidar@^3"], "5.0.0");
  for (const [selector, file] of Object.entries(patches)) {
    assert.equal(existsSync(join(root, file)), true, file);
    assert.equal(manifest.patchedDependencies[selector], file);
  }
});

test("root scripts and the install script do not invoke pnpm", () => {
  const manifest = JSON.parse(read("package.json"));
  for (const [name, script] of Object.entries(manifest.scripts)) {
    assert.equal(script.includes("pnpm"), false, name);
  }
  const install = read("scripts/dev/install-dependencies.sh");
  // The workspace glob file is still hashed. Nothing in the script runs pnpm.
  assert.match(install, /pnpm-workspace\.yaml/);
  assert.equal(install.replaceAll("pnpm-workspace.yaml", "").includes("pnpm"), false);
  assert.match(install, /npm ci/);
  assert.match(install, /package-lock\.json/);
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/quality/repository-size-gate.mjs");
const policyPath = "tools/quality/repository-size-policy.json";
const originalPolicy = JSON.parse(readFileSync(join(root, policyPath), "utf8"));
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "repository-size-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["init", "-q"]);
  mkdirSync(join(directory, "tools/quality"), { recursive: true });
  const policy = { ...originalPolicy, ...overrides };
  writeFileSync(join(directory, policyPath), JSON.stringify(policy));
  writeFileSync(join(directory, "source.txt"), "source\n");
  git(["add", "."]);
  const run = (args = [], cwd = directory) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const write = (path, text) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  };
  return { directory, git, policy, run, write };
}

test("source remains within explicit size budgets, including nonignored new files", (t) => {
  const f = fixture(t, { maxFiles: 2 });
  assert.equal(f.run().status, 0);
  f.write("new-source.txt", "new source");
  const result = f.run();
  assert.notEqual(result.status, 0);
});

test("working check ignores deletions, local ignored cache and old descendants of new links", (t) => {
  const f = fixture(t, { maxFiles: 3 });
  f.write("old/child.txt", "previous");
  f.git(["add", "old"]);
  rmSync(join(f.directory, "old"), { recursive: true });
  symlinkSync("tools", join(f.directory, "old"));
  f.write(".gitignore", "node_modules/\n");
  f.write("node_modules/huge.bin", "x".repeat(originalPolicy.maxFileBytes + 1));
  rmSync(join(f.directory, "source.txt"));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  f.write("extra.txt", "extra");
  assert.notEqual(f.run().status, 0);
});

test("staged snapshot is validated independently of unstaged size repairs", (t) => {
  const f = fixture(t, { maxFileBytes: 4096 });
  f.write("source.txt", "x".repeat(5000));
  f.git(["add", "source.txt"]);
  f.write("source.txt", "repaired");
  assert.equal(f.run().status, 0);
  const staged = f.run(["--staged"]);
  assert.notEqual(staged.status, 0);

  f.git(["add", "source.txt"]);
  f.write("source.txt", "x".repeat(5000));
  assert.equal(f.run(["--staged"]).status, 0);
  assert.notEqual(f.run().status, 0);
});

test("repository byte and file-count budgets fail closed", (t) => {
  const bytes = fixture(t, { maxTrackedBytes: 100 });
  assert.notEqual(bytes.run().status, 0);
  const files = fixture(t, { maxFiles: 1 });
  assert.notEqual(files.run().status, 0);
});

test("generated histories and caches cannot be force-added to Git", (t) => {
  const f = fixture(t);
  for (const path of [
    "work/report.json",
    "apps/pages/dist/runtime.js",
    "nested/node_modules/tool.js",
    "docs/security/cloudflare-audit/run-9/report.md",
    "kimi-reviews/pr1000-review.txt",
    "apps/pages/.impeccable/review/screen.png",
    "artifacts/coverage.json",
    "docs/design/canvases/auth-flow/Generated.dc.html",
  ]) {
    f.write(path, "generated");
    const result = f.run();
    assert.notEqual(result.status, 0, path);

    f.git(["add", "-f", path]);
    assert.notEqual(f.run(["--staged"]).status, 0, path);
    f.git(["rm", "--cached", "--", path]);
    rmSync(join(f.directory, path));
  }
});

test("staged deletion and calls from subdirectories use the complete repository snapshot", (t) => {
  const f = fixture(t, { maxFiles: 1 });
  assert.notEqual(f.run(["--staged"]).status, 0);
  f.git(["rm", "--cached", "source.txt"]);
  const result = f.run(["--staged"], join(f.directory, "tools"));
  assert.equal(result.status, 0, result.stderr);
});

test("symlinks count their link payload without following external targets", (t) => {
  const f = fixture(t);
  symlinkSync("/does-not-exist", join(f.directory, "linked"));
  assert.equal(f.run().status, 0);
  f.git(["add", "linked"]);
  assert.equal(f.run(["--staged"]).status, 0);
});

test("the staged policy is used rather than an unstaged relaxation", (t) => {
  const f = fixture(t, { maxFileBytes: 4096 });
  f.write("source.txt", "x".repeat(5000));
  f.git(["add", "source.txt"]);
  f.write(policyPath, JSON.stringify({ ...f.policy, maxFileBytes: 10000 }));
  assert.equal(f.run().status, 0);
  assert.notEqual(f.run(["--staged"]).status, 0);
});

test("unique design editor inputs remain allowed while reproducible outputs do not", (t) => {
  const f = fixture(t);
  f.write(
    "docs/design/canvases/settings-connectivity/Main.dc.html",
    "unique editor input",
  );
  f.write("docs/design/canvases/auth-flow/parts/Main.html", "source fragment");
  assert.equal(f.run().status, 0);
  f.git(["add", "."]);
  assert.equal(f.run(["--staged"]).status, 0);
});

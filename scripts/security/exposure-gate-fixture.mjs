/** A real repository containing the reviewed policy, its sources, and the executing checker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY_PATH } from "../lib/exposure-policy.mjs";
import { CHECKER_SOURCES } from "./exposure-matrix-gate.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
export const GATE = "scripts/security/exposure-matrix-gate.mjs";
export const POLICY = POLICY_PATH;
export const CLAIM = "packages/control-plane/src/routes/claim-presentation.ts";

function reviewedFiles(root, baseline) {
  const originals = new Map();
  const modes = new Map();
  const path = (name) => join(root, name);
  const write = (name, bytes) => {
    mkdirSync(dirname(path(name)), { recursive: true });
    writeFileSync(path(name), bytes);
  };
  for (const name of new Set([
    ...CHECKER_SOURCES,
    ...Object.keys(baseline.sources),
    POLICY,
    ".githooks/pre-push",
  ])) {
    const bytes = readFileSync(join(source, name));
    const mode = statSync(join(source, name)).mode & 0o777;
    originals.set(name, bytes);
    modes.set(name, mode);
    write(name, bytes);
    chmodSync(path(name), mode);
  }
  const read = (name) => readFileSync(path(name), "utf8");
  const replace = (name, before, after) => {
    const current = read(name);
    assert.ok(current.includes(before), `mutation anchor moved: ${name}`);
    write(name, current.replace(before, after));
  };
  const restore = (name) => {
    assert.ok(originals.has(name), `unreviewed fixture source: ${name}`);
    rmSync(path(name), { recursive: true, force: true });
    write(name, originals.get(name));
    chmodSync(path(name), modes.get(name));
  };
  return { path, write, read, replace, restore };
}

function gitTools(root, environment) {
  const command = (args, options = {}) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
      env: { ...environment, ...options.env },
    });
  const git = (args, input) => {
    const result = command(args, { input });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trimEnd();
  };
  const commit = (message = "fixture revision") => {
    git(["add", "--all"]);
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Exposure Fixture",
      "-c",
      "user.email=exposure@example.test",
      "commit",
      "-qm",
      message,
    ]);
    return git(["rev-parse", "HEAD"]);
  };
  return { command, git, commit };
}

export function gateFixture(t) {
  const container = mkdtempSync(join(tmpdir(), "exposure-gate-"));
  const root = join(container, "repository");
  mkdirSync(root);
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const baseline = JSON.parse(readFileSync(join(source, POLICY), "utf8"));
  const files = reviewedFiles(root, baseline);
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    NODE_OPTIONS: "",
  };
  const { command, git, commit } = gitTools(root, environment);
  git(["init", "-q", "--initial-branch=main"]);
  const head = commit("reviewed exposure baseline");
  const run = (args = [], options = {}) =>
    spawnSync(process.execPath, [files.path(GATE), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
      env: { ...environment, ...options.env },
    });
  return {
    root,
    container,
    head,
    ...files,
    git,
    command,
    commit,
    run,
    baseline,
  };
}

export function assertClean(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /exposure matrix: CLEAN/);
}

export function assertBlocked(result, rule) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, rule);
  assert.doesNotMatch(result.stdout, /exposure matrix: CLEAN/);
}

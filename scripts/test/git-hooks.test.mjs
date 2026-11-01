import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "opensesame-git-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const log = join(dir, "commands.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  for (const hook of ["pre-commit", "pre-push"]) {
    const target = join(dir, ".githooks", hook);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, ".githooks", hook), target);
  }
  function executable(name, body) {
    const target = join(bin, name);
    writeFileSync(target, `#!/bin/sh\n${body}\n`);
    chmodSync(target, 0o755);
  }
  for (const tool of ["node", "npm"]) {
    executable(
      tool,
      `test -z "\${NODE_OPTIONS:-}" || exit 98
printf '%s\\n' "${tool} $*" >> "$HOOK_LOG"
test "\${HOOK_FAIL:-}" != "${tool} $*" || exit 17`,
    );
  }
  executable(
    "git",
    `test "\${HOOK_DIFF_FAIL:-}" != 1 || exit 19
case "$*" in
  "diff --name-only HEAD") printf '%s\\n' "\${HOOK_WORKING_PATHS:-}" ;;
  "diff --cached --name-only --diff-filter=ACMR") printf '%s\\n' "\${HOOK_STAGED_PATHS:-}" ;;
  "diff --name-only "*) printf '%s\\n' "\${HOOK_CHANGED_PATHS:-}" ;;
  *) exit 20 ;;
esac`,
  );
  // Make the optional pre-commit scanner deterministic on any host.
  executable("gitleaks", "exit 0");
  const scanner = join(dir, "scripts/audit/gitleaks-gate.sh");
  mkdirSync(dirname(scanner), { recursive: true });
  writeFileSync(scanner, "exit 0\n");
  return {
    dir,
    run(hook = "pre-push", env = {}) {
      const inherited = { ...process.env };
      inherited.OPENSESAME_PREPUSH = undefined;
      inherited.LINT_SINCE = undefined;
      const result = spawnSync("sh", [join(dir, ".githooks", hook)], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...inherited,
          PATH: `${bin}:${process.env.PATH}`,
          HOOK_LOG: log,
          NODE_OPTIONS: "--invalid-inherited-option",
          ...env,
        },
      });
      return { ...result, commands: readFileSync(log, "utf8") };
    },
  };
}

test("ordinary pushes run static checks and typechecking without test suites", (t) => {
  const result = fixture(t).run();
  assert.equal(result.status, 0, result.stderr);
  for (const command of [
    "node scripts/security/exposure-matrix-gate.mjs --push-refs",
    "node scripts/quality/evidence-gate.mjs",
    "node scripts/quality/repository-size-gate.mjs",
    "node scripts/dev/sync-agent-skills.mjs --check",
    "node scripts/quality/lint-changed.mjs",
    "node apps/pages/scripts/build-static-auth.mjs --check",
    "npm run lint:anti-slop",
    "npm run quality:gate",
    "npm run quality:log-hygiene",
    "npm run quality:packages",
    "npm run quality:app-core",
    "npm run typecheck",
  ]) {
    assert.ok(result.commands.includes(`${command}\n`), command);
  }
  assert.doesNotMatch(
    result.commands,
    /npm run (?:test\b|verify\b|quality\n|lint\n)/,
  );
  assert.doesNotMatch(result.commands, /npm run audit:clippy/);
});

test("Rust lint catches committed and working-tree changes before push", (t) => {
  for (const variable of ["HOOK_CHANGED_PATHS", "HOOK_WORKING_PATHS"]) {
    const result = fixture(t).run("pre-push", {
      [variable]: "crates/domain/src/lib.rs\n",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.commands, /npm run audit:clippy\n/);
  }
});

test("toolchain and Cargo configuration changes receive commit-time Rust lint", (t) => {
  for (const path of [
    "rust-toolchain",
    "rust-toolchain.toml",
    ".cargo/config.toml",
    "scripts/audit/clippy-gate.sh",
  ]) {
    const result = fixture(t).run("pre-commit", { HOOK_STAGED_PATHS: path });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.commands, /npm run audit:clippy\n/, path);
  }
});

test("a failed static check or unreadable diff stops the push", (t) => {
  const checks = fixture(t).run("pre-push", {
    HOOK_FAIL: "npm run quality:gate",
  });
  assert.equal(checks.status, 17);
  assert.doesNotMatch(checks.commands, /npm run typecheck/);
  assert.doesNotMatch(checks.stdout, /pre-push: OK/);

  const diff = fixture(t).run("pre-push", { HOOK_DIFF_FAIL: "1" });
  assert.equal(diff.status, 19);
  assert.doesNotMatch(diff.stdout, /pre-push: OK/);
});

test("full verification stays an explicit local opt-in", (t) => {
  const result = fixture(t).run("pre-push", { OPENSESAME_PREPUSH: "full" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.commands, /npm run verify\n/);
  assert.match(
    result.commands,
    /node scripts\/security\/exposure-matrix-gate\.mjs --push-refs\n/,
  );
  assert.doesNotMatch(result.commands, /npm run typecheck/);
});

test("off skips optional checks but still enforces exposure policy; unknown modes fail", (t) => {
  const disabled = fixture(t).run("pre-push", { OPENSESAME_PREPUSH: "off" });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(
    disabled.commands,
    "node scripts/security/exposure-matrix-gate.mjs --push-refs\n",
  );
  const invalid = fixture(t).run("pre-push", { OPENSESAME_PREPUSH: "typo" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.commands, "");
});

test("exposure failure stops every push mode before optional checks", (t) => {
  for (const mode of ["off", "fast", "full"]) {
    const result = fixture(t).run("pre-push", {
      OPENSESAME_PREPUSH: mode,
      HOOK_FAIL: "node scripts/security/exposure-matrix-gate.mjs --push-refs",
    });
    assert.equal(result.status, 17);
    assert.equal(
      result.commands,
      "node scripts/security/exposure-matrix-gate.mjs --push-refs\n",
    );
    assert.doesNotMatch(result.stdout, /pre-push: OK/);
  }
});

test("commits check index exposure before any working-tree lint", (t) => {
  const result = fixture(t).run("pre-commit", {
    HOOK_STAGED_PATHS: "packages/control-plane/src/routes/claims.ts",
    HOOK_FAIL: "node scripts/security/exposure-matrix-gate.mjs --staged",
  });
  assert.equal(result.status, 17);
  assert.equal(
    result.commands,
    "node scripts/security/exposure-matrix-gate.mjs --staged\n",
  );
  assert.doesNotMatch(result.stdout, /pre-commit: OK/);
});

test("hook setup is idempotent and installs both executable hooks", (t) => {
  const { dir } = fixture(t);
  const script = join(dir, "scripts/dev/setup-hooks.sh");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(join(root, "scripts/dev/setup-hooks.sh"), script);
  for (const hook of ["pre-commit", "pre-push"]) {
    chmodSync(join(dir, ".githooks", hook), 0o644);
  }
  assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const setup = spawnSync("bash", [script], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    assert.equal(setup.status, 0, setup.stderr);
  }
  const installed = spawnSync(
    "git",
    ["-C", dir, "config", "--local", "core.hooksPath"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout.trim(), ".githooks");
  for (const hook of ["pre-commit", "pre-push"]) {
    assert.ok(statSync(join(dir, ".githooks", hook)).mode & 0o111);
  }
});

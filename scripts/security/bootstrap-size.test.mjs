import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-size-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ["scripts/dev", ".claude/hooks", "bin"])
    mkdirSync(join(dir, folder), { recursive: true });
  for (const name of [
    "scripts/dev/install-dependencies.sh",
    ".claude/hooks/session-start.sh",
  ])
    copyFileSync(join(root, name), join(dir, name));
  writeFileSync(
    join(dir, "package.json"),
    '{"packageManager":"pnpm@9.15.0"}\n',
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  execFileSync("git", ["init", "-q"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync("git", ["add", "."], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(
    join(dir, "bin/pnpm"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BOOTSTRAP_TEST_LOG"\n[ "${BOOTSTRAP_TEST_FAIL:-}" != 1 ] || exit 3\nmkdir -p node_modules\ntouch node_modules/.modules.yaml\n',
    { mode: 0o755 },
  );
  const log = join(dir, "calls.txt");
  const env = {
    ...process.env,
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    BOOTSTRAP_TEST_LOG: log,
  };
  for (const name of [
    "OPENSESAME_AGENT_BOOTSTRAP",
    "OPENSESAME_ENV",
    "OPENSESAME_CLAIM_PEPPER",
    "OPENSESAME_AUTH_SECRET",
  ])
    delete env[name];
  const run = (extra = {}) =>
    spawnSync("bash", [".claude/hooks/session-start.sh"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { dir, run, calls };
}

test("session and remote harness flags do not implicitly install or generate", (t) => {
  const f = fixture(t);
  for (const flags of [{}, { CLAUDECODE: "1" }, { CLAUDE_CODE_REMOTE: "true" }])
    assert.equal(f.run(flags).status, 0);
  assert.deepEqual(f.calls(), []);
});

test("explicit bootstrap installs frozen dependencies once and notices lock changes", (t) => {
  const f = fixture(t);
  for (let n = 0; n < 2; n++) {
    const result = f.run({ OPENSESAME_AGENT_BOOTSTRAP: "1" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(f.calls(), ["install --frozen-lockfile"]);
  writeFileSync(
    join(f.dir, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n# changed\n",
  );
  assert.equal(f.run({ OPENSESAME_AGENT_BOOTSTRAP: "1" }).status, 0);
  assert.deepEqual(f.calls(), [
    "install --frozen-lockfile",
    "install --frozen-lockfile",
  ]);
});

test("failed installs never acquire a success fingerprint", (t) => {
  const f = fixture(t);
  assert.notEqual(
    f.run({ OPENSESAME_AGENT_BOOTSTRAP: "1", BOOTSTRAP_TEST_FAIL: "1" }).status,
    0,
  );
  assert.equal(
    existsSync(join(f.dir, "node_modules/.cache/opensesame-install.sha256")),
    false,
  );
  assert.equal(f.run({ OPENSESAME_AGENT_BOOTSTRAP: "1" }).status, 0);
  assert.equal(f.calls().length, 2);
});

test("production credential gate remains in effect for explicit bootstrap", (t) => {
  const f = fixture(t);
  assert.equal(
    f.run({ OPENSESAME_AGENT_BOOTSTRAP: "1", OPENSESAME_ENV: "production" })
      .status,
    0,
  );
  assert.deepEqual(f.calls(), []);
});

test("an untracked new workspace manifest invalidates the install fingerprint", (t) => {
  const f = fixture(t);
  assert.equal(f.run({ OPENSESAME_AGENT_BOOTSTRAP: "1" }).status, 0);
  mkdirSync(join(f.dir, "packages/new-package"), { recursive: true });
  writeFileSync(
    join(f.dir, "packages/new-package/package.json"),
    '{"name":"new-package"}\n',
  );
  assert.equal(f.run({ OPENSESAME_AGENT_BOOTSTRAP: "1" }).status, 0);
  assert.deepEqual(f.calls(), [
    "install --frozen-lockfile",
    "install --frozen-lockfile",
  ]);
});

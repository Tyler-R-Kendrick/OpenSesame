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
    '{"name":"bootstrap","private":true}\n',
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    `${JSON.stringify({
      name: "bootstrap",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "bootstrap" } },
    })}\n`,
  );
  execFileSync("git", ["init", "-q"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync("git", ["add", "."], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(
    join(dir, "bin/npm"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$BOOTSTRAP_TEST_LOG"',
      'printf "%s\\n" "${CI:-}" >> "$BOOTSTRAP_TEST_CI_LOG"',
      '[ "${BOOTSTRAP_TEST_FAIL:-}" != 1 ] || exit 3',
      '[ "${BOOTSTRAP_TEST_CANCEL:-}" != 1 ] || exit 0',
      "mkdir -p node_modules",
      'if [ "${BOOTSTRAP_TEST_NO_LOCK:-}" = 1 ]; then printf "%s\\n" "{}" > node_modules/.package-lock.json; elif [ "${BOOTSTRAP_TEST_NO_MODULES:-}" != 1 ]; then cp package-lock.json node_modules/.package-lock.json; fi',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const log = join(dir, "calls.txt");
  const ciLog = join(dir, "ci.txt");
  const env = {
    ...process.env,
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    BOOTSTRAP_TEST_LOG: log,
    BOOTSTRAP_TEST_CI_LOG: ciLog,
  };
  for (const name of [
    "OPENSESAME_AGENT_BOOTSTRAP",
    "OPENSESAME_ENV",
    "OPENSESAME_CLAIM_PEPPER",
    "OPENSESAME_AUTH_SECRET",
  ])
    delete env[name];
  const invoke = (script, extra) =>
    spawnSync("bash", [script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
  const run = (extra = {}) => invoke(".claude/hooks/session-start.sh", extra);
  const install = (extra = {}) =>
    invoke("scripts/dev/install-dependencies.sh", extra);
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { dir, run, install, calls, ciLog };
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
  assert.deepEqual(f.calls(), ["ci"]);
  writeFileSync(
    join(f.dir, "package-lock.json"),
    `${JSON.stringify({
      name: "bootstrap",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "bootstrap", version: "changed" } },
    })}\n`,
  );
  assert.equal(f.run({ OPENSESAME_AGENT_BOOTSTRAP: "1" }).status, 0);
  assert.deepEqual(f.calls(), [
    "ci",
    "ci",
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
    "ci",
    "ci",
  ]);
});

test("direct installs force noninteractive npm and reuse a matching installation", (t) => {
  const f = fixture(t);
  const first = f.install({ CI: "false" });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(f.calls(), ["ci"]);
  assert.equal(readFileSync(f.ciLog, "utf8"), "true\n");
  const marker = join(f.dir, "node_modules/.cache/opensesame-install.sha256");
  const fingerprint = readFileSync(marker, "utf8");
  const second = f.install();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /current lockfile already installed/);
  assert.deepEqual(f.calls(), ["ci"]);
  assert.equal(readFileSync(marker, "utf8"), fingerprint);
});

test("an exit-zero cancelled reinstall cannot bless a stale module lock", (t) => {
  const f = fixture(t);
  assert.equal(f.install().status, 0);
  const installedLock = join(f.dir, "node_modules/.package-lock.json");
  writeFileSync(installedLock, "{}\n");
  const cancelled = f.install({ BOOTSTRAP_TEST_CANCEL: "1" });
  assert.equal(cancelled.status, 1, cancelled.stderr);
  assert.match(
    cancelled.stderr,
    /installed module lockfile does not match package-lock\.json/,
  );
  assert.equal(
    existsSync(join(f.dir, "node_modules/.cache/opensesame-install.sha256")),
    false,
  );
  assert.equal(f.calls().length, 2);
  const recovered = f.install();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(
    readFileSync(installedLock, "utf8"),
    readFileSync(join(f.dir, "package-lock.json"), "utf8"),
  );
  assert.equal(f.calls().length, 3);
});

test("exit-zero installs missing the npm module lock do not get a marker", (t) => {
  for (const failure of [
    { BOOTSTRAP_TEST_NO_MODULES: "1" },
    { BOOTSTRAP_TEST_NO_LOCK: "1" },
  ]) {
    const f = fixture(t);
    const incomplete = f.install(failure);
    assert.equal(incomplete.status, 1, incomplete.stderr);
    assert.equal(
      existsSync(join(f.dir, "node_modules/.cache/opensesame-install.sha256")),
      false,
    );
    assert.equal(f.install().status, 0);
    assert.equal(f.calls().length, 2);
  }
});

test("cache hits require a matching npm module lock even with a marker", (t) => {
  for (const missing of [".package-lock.json"]) {
    const f = fixture(t);
    assert.equal(f.install().status, 0);
    rmSync(join(f.dir, "node_modules", missing));
    const repaired = f.install();
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(f.calls().length, 2);
    assert.equal(f.install().status, 0);
    assert.equal(f.calls().length, 2);
  }
});

test("a changed lock and failed install invalidate the earlier success marker", (t) => {
  const f = fixture(t);
  assert.equal(f.install().status, 0);
  writeFileSync(
    join(f.dir, "package-lock.json"),
    `${JSON.stringify({
      name: "bootstrap",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "bootstrap", version: "new-resolution" } },
    })}\n`,
  );
  const failed = f.install({ BOOTSTRAP_TEST_FAIL: "1" });
  assert.equal(failed.status, 3, failed.stderr);
  assert.equal(
    existsSync(join(f.dir, "node_modules/.cache/opensesame-install.sha256")),
    false,
  );
  assert.equal(f.install().status, 0);
  assert.equal(f.calls().length, 3);
  assert.equal(f.install().status, 0);
  assert.equal(f.calls().length, 3);
});

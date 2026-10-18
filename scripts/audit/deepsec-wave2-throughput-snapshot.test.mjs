import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL(
  "./deepsec-wave2-throughput-snapshot.mjs",
  import.meta.url,
);
test("snapshot rejects a planted directory and supports a private baseline", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-private-test-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".deepsec/data/opensesame/files"), {
      recursive: true,
    });
    const target = join(dir, "sentinel");
    writeFileSync(target, "unchanged");
    const state = join(
      dir,
      `opensesame-deepsec-${process.getuid?.() ?? "local"}`,
    );
    symlinkSync(dir, state);
    const run = (command) =>
      spawnSync(process.execPath, [script.pathname, command, repo], {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: dir },
        timeout: 10000,
      });
    const rejected = run("baseline");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Unsafe snapshot directory/);
    assert.equal(readFileSync(target, "utf8"), "unchanged");
    rmSync(state);
    const baseline = run("baseline");
    assert.equal(baseline.status, 0, baseline.stderr);
    const report = run("report");
    assert.equal(report.status, 0, report.stderr);
    assert.equal(JSON.parse(report.stdout).deltaFiles, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

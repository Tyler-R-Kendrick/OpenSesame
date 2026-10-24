import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(
  new URL("./assert-no-advisories.mjs", import.meta.url),
);
function runReport(contents) {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-advisory-gate-"));
  try {
    const report = join(directory, "findings.json");
    writeFileSync(report, contents, { mode: 0o600 });
    const result = spawnSync(process.execPath, [gate, report], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("empty scanner findings pass", () => {
  const result = runReport("[]");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /CLEAN/);
});

test("every advisory fails, including former backport exceptions", () => {
  for (const finding of [
    {
      id: "GHSA-vfj7-8cjw-p6xm",
      ecosystem: "npm",
      package: "braces",
      version: "3.0.3",
    },
    {
      id: "GHSA-86w9-cpqp-85rv",
      ecosystem: "npm",
      package: "node-forge",
      version: "1.4.0",
    },
    {
      id: "OSV-unrecognized",
      ecosystem: "unknown",
      package: "other",
      version: "1",
    },
    null,
  ]) {
    const result = runReport(JSON.stringify([finding]));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL/);
    assert.doesNotMatch(result.stdout, /CLEAN/);
  }
});

test("malformed and missing reports fail closed", () => {
  for (const contents of ["", "{", "null", "{}", '"[]"', "false"]) {
    const result = runReport(contents);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL/);
  }
  for (const args of [[], ["/no/such/opensesame-findings.json"]]) {
    const result = spawnSync(process.execPath, [gate, ...args], {
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL/);
  }
});

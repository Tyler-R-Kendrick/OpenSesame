import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCleanCodeql,
  checkCodeqlDirectory,
} from "./check-codeql-sarif.mjs";

const clean = () => ({
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "CodeQL" } },
      invocations: [{ executionSuccessful: true }],
      results: [],
    },
  ],
});

test("accepts an explicitly successful analysis with zero findings", () => {
  assert.doesNotThrow(() => assertCleanCodeql(clean()));
});

test("rejects findings, missing reports, wrong tools and incomplete execution", () => {
  for (const mutate of [
    (r) => {
      r.runs[0].results.push({ ruleId: "js/xss" });
    },
    (r) => {
      r.runs[0].invocations[0].executionSuccessful = false;
    },
    (r) => {
      r.runs[0].results = undefined;
    },
    (r) => {
      r.runs[0].invocations = [];
    },
    (r) => {
      r.runs[0].tool.driver.name = "unknown";
    },
    (r) => {
      r.runs[0].invocations[0].toolExecutionNotifications = [
        { level: "error" },
      ];
    },
    (r) => {
      r.runs[0].invocations[0].toolConfigurationNotifications = [
        { level: "error" },
      ];
    },
    (r) => {
      r.runs[0].invocations[0].toolExecutionNotifications = "error";
    },
    (r) => {
      r.runs[0].invocations[0].toolConfigurationNotifications = [null];
    },
    (r) => {
      r.runs = [];
    },
  ]) {
    const report = clean();
    mutate(report);
    assert.throws(() => assertCleanCodeql(report));
  }
});

test("a missing or malformed report cannot pass the directory gate", () => {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-codeql-test-"));
  try {
    assert.throws(() => checkCodeqlDirectory(directory));
    writeFileSync(join(directory, "results.sarif"), "not JSON");
    assert.throws(() => checkCodeqlDirectory(directory));
    writeFileSync(join(directory, "results.sarif"), JSON.stringify(clean()));
    assert.equal(checkCodeqlDirectory(directory), 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

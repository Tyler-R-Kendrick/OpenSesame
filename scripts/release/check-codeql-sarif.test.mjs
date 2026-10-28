import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// These are the exact two findings retained in main's 660eef2 CodeQL SARIF.
// Their full result (including dataflow), not merely the sink, was reviewed.
test("only the exact reviewed SARIF results pass across controller updates", () => {
  const results = JSON.parse(
    readFileSync(
      new URL("./fixtures/codeql-reviewed-660.json", import.meta.url),
      "utf8",
    ),
  );
  const report = clean();
  report.runs[0].automationDetails = { id: "/language:javascript-typescript/" };
  report.runs[0].results = results;
  assert.deepEqual(assertCleanCodeql(report), [
    "federated cookie integrity HMAC",
    "password-reset journal filename HMAC",
  ]);
  for (const mutate of [
    (r) => {
      r.runs[0].results[0].ruleId = "js/xss";
    },
    (r) => {
      r.runs[0].results[0].locations[0].physicalLocation.region.startColumn++;
    },
    (r) => {
      Reflect.deleteProperty(
        r.runs[0].results[0].partialFingerprints,
        "primaryLocationLineHash",
      );
    },
    (r) => {
      r.runs[0].results[0].codeFlows[0].threadFlows[0].locations.pop();
    },
    (r) => {
      r.runs[0].results.push({ ruleId: "js/xss" });
    },
    (r) => {
      r.runs[0].results.push(r.runs[0].results[0]);
    },
    (r) => {
      r.runs[0].automationDetails.id = "/language:python/";
    },
    (r) => {
      r.runs[0].invocations[0].toolExecutionNotifications = [
        { level: "error" },
      ];
    },
  ]) {
    const modified = structuredClone(report);
    mutate(modified);
    assert.throws(() => assertCleanCodeql(modified));
  }
  const reordered = structuredClone(report);
  reordered.runs[0].results[0] = Object.fromEntries(
    Object.entries(reordered.runs[0].results[0]).reverse(),
  );
  assert.doesNotThrow(() => assertCleanCodeql(reordered));
});

test("accepts only the exact reviewed native TLS result", () => {
  const result = JSON.parse(
    readFileSync(
      new URL("./fixtures/codeql-reviewed-native.json", import.meta.url),
      "utf8",
    ),
  );
  const report = clean();
  report.runs[0].automationDetails = { id: "/language:go-native-wasm/" };
  report.runs[0].results = [result];
  assert.deepEqual(assertCleanCodeql(report), [
    "Tailscale custom certificate and hostname verification",
  ]);
  result.partialFingerprints.primaryLocationLineHash = "changed:1";
  assert.throws(() => assertCleanCodeql(report));
});

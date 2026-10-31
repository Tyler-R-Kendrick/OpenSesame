import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertMutationReport,
  assertStrykerReport,
} from "./deep-mutation-report.mjs";

test("Rust mutation requires nonempty, complete, survivor-free results", () => {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-mutants-test-"));
  const output = join(directory, "mutants.out");
  mkdirSync(output);
  const clean = {
    total_mutants: 5,
    caught: 4,
    unviable: 1,
    missed: 0,
    timeout: 0,
    success: 0,
  };
  try {
    assert.throws(() => assertMutationReport(directory));
    for (const mutation of [
      { total_mutants: 0, caught: 0, unviable: 0 },
      { missed: 1 },
      { timeout: 1 },
      { caught: 0, unviable: 5 },
      { total_mutants: 6 },
      { total_mutants: "5" },
    ]) {
      writeFileSync(
        join(output, "outcomes.json"),
        JSON.stringify({ ...clean, ...mutation }),
      );
      assert.throws(() => assertMutationReport(directory));
    }
    writeFileSync(join(output, "outcomes.json"), JSON.stringify(clean));
    assert.doesNotThrow(() => assertMutationReport(directory));
    writeFileSync(join(directory, "outcomes.json"), JSON.stringify(clean));
    assert.throws(() => assertMutationReport(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Stryker requires current source, complete declared scope and executed mutants", () => {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-stryker-test-"));
  const source = "export const allowed = (a, b) => a === b;\n";
  const reportPath = join(directory, "report.json");
  const configPath = join(directory, "config.json");
  const config = {
    mutate: ["boundary.ts"],
    thresholds: { high: 100, low: 100, break: 100 },
  };
  const clean = () => ({
    schemaVersion: "1.0",
    framework: { name: "StrykerJS" },
    thresholds: config.thresholds,
    files: {
      "boundary.ts": { source, mutants: [{ id: "0", status: "Killed" }] },
    },
  });
  const check = (report) => {
    writeFileSync(reportPath, JSON.stringify(report));
    return () => assertStrykerReport(reportPath, configPath, directory);
  };
  try {
    writeFileSync(join(directory, "boundary.ts"), source);
    writeFileSync(configPath, JSON.stringify(config));
    assert.doesNotThrow(check(clean()));
    const timeout = clean();
    timeout.files["boundary.ts"].mutants[0].status = "Timeout";
    assert.doesNotThrow(check(timeout)); // Preserve Stryker's detected-mutant policy.
    for (const mutate of [
      (report) => {
        report.files = {};
      },
      (report) => {
        report.files["boundary.ts"].mutants = [];
      },
      (report) => {
        report.files["boundary.ts"].source = "old source";
      },
      (report) => {
        report.thresholds = { ...config.thresholds, break: 80 };
      },
      (report) => {
        report.files["boundary.ts"].mutants.push({ id: "0", status: "Killed" });
      },
      (report) => {
        report.files["other.ts"] = report.files["boundary.ts"];
      },
      (report) => {
        report.framework.name = "another tool";
      },
      ...[
        "Survived",
        "NoCoverage",
        "Pending",
        "RuntimeError",
        "Ignored",
        "CompileError",
        "unknown",
      ].map((status) => (report) => {
        report.files["boundary.ts"].mutants[0].status = status;
      }),
    ]) {
      const report = clean();
      mutate(report);
      assert.throws(check(report));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

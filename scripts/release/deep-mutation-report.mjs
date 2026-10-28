#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isJsonObject, isString } from "../lib/json-boundary.mjs";

function reportPaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return reportPaths(path);
    return entry.isFile() && entry.name === "outcomes.json" ? [path] : [];
  });
}

export function assertMutationReport(directory) {
  const reports = reportPaths(directory);
  if (reports.length !== 1)
    throw new Error("Expected exactly one Rust mutation result");
  const result = JSON.parse(readFileSync(reports[0], "utf8"));
  if (!Number.isSafeInteger(result.total_mutants) || result.total_mutants < 1) {
    throw new Error("Rust mutation scope is empty or incomplete");
  }
  for (const count of ["caught", "missed", "timeout", "unviable"]) {
    if (!Number.isSafeInteger(result[count]) || result[count] < 0) {
      throw new Error(`Missing Rust mutation count: ${count}`);
    }
  }
  if (result.missed || result.timeout || result.caught < 1) {
    throw new Error("Rust mutants survived, timed out, or none were caught");
  }
  if (result.caught + result.unviable !== result.total_mutants) {
    throw new Error(
      "Rust mutation results do not cover the complete selected scope",
    );
  }
}

function assertStrykerThresholds(report, config) {
  for (const key of ["high", "low", "break"]) {
    if (config.thresholds?.[key] !== 100 || report.thresholds?.[key] !== 100) {
      throw new Error("The scoped Stryker threshold must remain 100");
    }
  }
}

function assertStrykerScope(report, config) {
  if (
    !Array.isArray(config.mutate) ||
    config.mutate.length === 0 ||
    config.mutate.some((file) => !isString(file) || /[*!?{}]/.test(file))
  ) {
    throw new Error("Stryker requires an explicit nonempty source-file scope");
  }
  if (
    !isJsonObject(report.files) ||
    JSON.stringify(Object.keys(report.files).sort()) !==
      JSON.stringify([...config.mutate].sort())
  ) {
    throw new Error(
      "Stryker results do not cover the complete selected source scope",
    );
  }
}

function detectedMutant(mutant) {
  // Stryker counts a timed-out mutant as detected. Preserve that existing
  // score policy; compile errors are nonviable and explicit ignores excluded.
  if (["Killed", "Timeout"].includes(mutant.status)) return 1;
  if (["CompileError", "Ignored"].includes(mutant.status)) return 0;
  throw new Error(
    `Stryker mutation survived or failed to execute: ${mutant.status}`,
  );
}

function assertStrykerFile(file, result, sourceRoot) {
  if (
    result?.source !== readFileSync(resolve(sourceRoot, file), "utf8") ||
    !Array.isArray(result.mutants) ||
    result.mutants.length === 0
  ) {
    throw new Error(
      `Stryker source is stale or its mutation scope is empty: ${file}`,
    );
  }
  const ids = new Set();
  let detected = 0;
  for (const mutant of result.mutants) {
    if (!isString(mutant?.id) || ids.has(mutant.id)) {
      throw new Error("Missing or duplicate Stryker mutant identity");
    }
    ids.add(mutant.id);
    detected += detectedMutant(mutant);
  }
  return detected;
}

/** Stryker's 100% score is meaningful only for the complete current source scope. */
export function assertStrykerReport(
  reportPath,
  configPath,
  sourceRoot = process.cwd(),
) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    report?.schemaVersion !== "1.0" ||
    report.framework?.name !== "StrykerJS"
  ) {
    throw new Error("Missing or invalid Stryker report identity");
  }
  assertStrykerThresholds(report, config);
  assertStrykerScope(report, config);
  let detected = 0;
  for (const [file, result] of Object.entries(report.files)) {
    detected += assertStrykerFile(file, result, sourceRoot);
  }
  if (detected === 0) throw new Error("No viable Stryker mutants were tested");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv[2] === "typescript" && process.argv.length === 5) {
    assertStrykerReport(process.argv[3], process.argv[4]);
  } else if (process.argv.length === 3) {
    assertMutationReport(process.argv[2]);
  } else {
    throw new Error(
      "Usage: deep-mutation-report.mjs DIRECTORY | typescript REPORT CONFIG",
    );
  }
}

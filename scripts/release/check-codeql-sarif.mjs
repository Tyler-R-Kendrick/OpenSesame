#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function assertNotifications(notifications = []) {
  if (!Array.isArray(notifications))
    throw new Error("Malformed CodeQL notifications");
  for (const notice of notifications) {
    if (!notice || typeof notice !== "object" || notice.level === "error") {
      throw new Error("CodeQL reported an execution or configuration error");
    }
  }
}

function assertInvocation(invocation) {
  if (invocation.executionSuccessful !== true) {
    throw new Error("CodeQL execution did not succeed");
  }
  assertNotifications(invocation.toolExecutionNotifications ?? []);
  assertNotifications(invocation.toolConfigurationNotifications ?? []);
}

function assertCodeqlRun(run) {
  if (run.tool?.driver?.name !== "CodeQL" || !Array.isArray(run.results)) {
    throw new Error("Incomplete CodeQL results");
  }
  if (!Array.isArray(run.invocations) || !run.invocations.length) {
    throw new Error("Missing CodeQL execution evidence");
  }
  for (const invocation of run.invocations) assertInvocation(invocation);
  if (run.results.length) {
    throw new Error(
      `CodeQL reported ${run.results.length} findings; review the retained SARIF`,
    );
  }
}

/** Uploading SARIF reports findings; it is not itself a passing security gate. */
export function assertCleanCodeql(report) {
  if (
    report?.version !== "2.1.0" ||
    !Array.isArray(report.runs) ||
    !report.runs.length
  ) {
    throw new Error("Missing or invalid CodeQL SARIF runs");
  }
  for (const run of report.runs) assertCodeqlRun(run);
}

export function checkCodeqlDirectory(directory) {
  const files = readdirSync(directory, { withFileTypes: true });
  const reports = files.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".sarif"),
  );
  if (!reports.length) throw new Error("No CodeQL SARIF report was produced");
  for (const entry of reports) {
    assertCleanCodeql(
      JSON.parse(readFileSync(join(directory, entry.name), "utf8")),
    );
  }
  return reports.length;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw new Error("Usage: check-codeql-sarif.mjs DIRECTORY");
  console.log(
    `CodeQL gate: ${checkCodeqlDirectory(process.argv[2])} complete, clean reports`,
  );
}

#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isJsonObject } from "../lib/json-boundary.mjs";
import {
  REVIEWED_NATIVE_RESULTS,
  reviewedResultDigest,
} from "../lib/reviewed-codeql.mjs";

// Each complete result and its full candidate source inputs are pinned.
// Updating the controller-owned review record does not change its own input
// digest; other candidate tree changes require a fresh review for retained findings.
// These are keyed HMACs for integrity/opaque filenames, not password hashes.
const REVIEWED_RESULTS = new Map([
  [
    "89912a6f26da5bb7d6633e3f932c3d47f1ab730b1575b71eda67ee41fd1c70f8",
    "federated cookie integrity HMAC",
  ],
  [
    "9e387595117b19633fa040eb1717423403258e8264c8029ed070b5f93aa27f57",
    "password-reset journal filename HMAC",
  ],
]);

const REVIEWED_INPUTS = JSON.parse(
  readFileSync(
    new URL("./codeql-reviewed-inputs.json", import.meta.url),
    "utf8",
  ),
);

function reviewedResult(result, category, sourceDigest) {
  if (!/^[a-f0-9]{64}$/.test(sourceDigest)) return undefined;
  const digest = reviewedResultDigest(result);
  const approved = REVIEWED_INPUTS[category]?.[sourceDigest];
  if (!Array.isArray(approved) || !approved.includes(digest)) return undefined;
  if (category === "/language:javascript-typescript/")
    return REVIEWED_RESULTS.get(digest);
  if (
    ["/language:go-native-wasm/", "/language:go-native-host/"].includes(
      category,
    )
  )
    return REVIEWED_NATIVE_RESULTS.get(digest);
  return undefined;
}

function assertNotifications(notifications = []) {
  if (!Array.isArray(notifications))
    throw new Error("Malformed CodeQL notifications");
  for (const notice of notifications) {
    if (
      !(isJsonObject(notice) || Array.isArray(notice)) ||
      notice.level === "error"
    ) {
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

function assertCodeqlRun(run, sourceDigest) {
  if (run.tool?.driver?.name !== "CodeQL" || !Array.isArray(run.results)) {
    throw new Error("Incomplete CodeQL results");
  }
  if (!Array.isArray(run.invocations) || !run.invocations.length) {
    throw new Error("Missing CodeQL execution evidence");
  }
  for (const invocation of run.invocations) assertInvocation(invocation);
  const reviewed = [];
  for (const result of run.results) {
    const finding = reviewedResult(
      result,
      run.automationDetails?.id,
      sourceDigest,
    );
    if (!finding || reviewed.includes(finding)) {
      throw new Error(
        "CodeQL reported an unreviewed finding; review the retained SARIF",
      );
    }
    reviewed.push(finding);
  }
  return reviewed;
}

/** Uploading SARIF reports findings; it is not itself a passing security gate. */
export function assertCleanCodeql(report, sourceDigest) {
  if (
    report?.version !== "2.1.0" ||
    !Array.isArray(report.runs) ||
    !report.runs.length
  ) {
    throw new Error("Missing or invalid CodeQL SARIF runs");
  }
  const reviewed = report.runs.flatMap((run) =>
    assertCodeqlRun(run, sourceDigest),
  );
  if (new Set(reviewed).size !== reviewed.length)
    throw new Error("Duplicate CodeQL reviewed finding");
  return reviewed;
}

export function checkCodeqlDirectory(directory, sourceDigest) {
  const files = readdirSync(directory, { withFileTypes: true });
  const reports = files.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".sarif"),
  );
  if (!reports.length) throw new Error("No CodeQL SARIF report was produced");
  for (const entry of reports) {
    const reviewed = assertCleanCodeql(
      JSON.parse(readFileSync(join(directory, entry.name), "utf8")),
      sourceDigest,
    );
    for (const finding of reviewed)
      console.log(`CodeQL reviewed disposition: ${finding}`);
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

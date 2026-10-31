#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageViolations } from "../lib/exposure-coverage.mjs";
import {
  POLICY_PATH,
  exposureViolations,
  parsePolicy,
} from "../lib/exposure-policy.mjs";
import {
  indexSnapshot,
  pushedSnapshots,
  revisionSnapshot,
  worktreeSnapshot,
} from "../lib/exposure-snapshot.mjs";

// These are the actual executing bytes. Commit/push checks cannot borrow an
// unstaged checker fix while shipping different checker or parser code.
export const CHECKER_SOURCES = Object.freeze([
  "scripts/security/exposure-matrix-gate.mjs",
  "scripts/lib/exposure-policy.mjs",
  "scripts/lib/exposure-contracts.mjs",
  "scripts/lib/exposure-local-vault.mjs",
  "scripts/lib/exposure-native-provider.mjs",
  "scripts/lib/exposure-rules.mjs",
  "scripts/lib/exposure-coverage.mjs",
  "scripts/lib/exposure-snapshot.mjs",
  "scripts/lib/json-boundary.mjs",
  "scripts/lib/json-text.mjs",
  "scripts/lib/read-pinned-file.mjs",
]);

export function checkSnapshot(snapshot) {
  if (!/^100(?:644|755)$/u.test(snapshot.mode(POLICY_PATH)))
    throw new Error("EM-SOURCE: matrix is not a regular file");
  const policy = parsePolicy(snapshot.read(POLICY_PATH));
  const errors = exposureViolations(policy).map(
    ({ surface, rule, reason }) => `${rule}: ${surface}: ${reason}`,
  );
  errors.push(...coverageViolations(policy, snapshot));
  if (errors.length) throw new Error(errors.join("\n"));
  return {
    surfaces: policy.surfaces.length,
    sources: Object.keys(policy.sources).length,
  };
}

function sameChecker(working, target) {
  for (const path of CHECKER_SOURCES) {
    if (
      working.mode(path) !== target.mode(path) ||
      !working.read(path).equals(target.read(path))
    ) {
      throw new Error(
        `EM-CHECKER-SNAPSHOT: ${path} differs from ${target.label}; stage/check out the intended checker too`,
      );
    }
  }
}

function main() {
  try {
    const args = process.argv.slice(2);
    const valid =
      args.length === 0 ||
      (args.length === 1 && ["--staged", "--push-refs"].includes(args[0])) ||
      (args.length === 2 && args[0] === "--ref");
    if (!valid)
      throw new Error(
        "usage: exposure-matrix-gate.mjs [--staged | --push-refs | --ref REVISION]",
      );
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    const working = worktreeSnapshot(root);
    let snapshots = [working];
    if (args[0] === "--staged") snapshots = [indexSnapshot(root)];
    if (args[0] === "--ref") snapshots = [revisionSnapshot(root, args[1])];
    if (args[0] === "--push-refs")
      snapshots = pushedSnapshots(
        root,
        process.stdin.isTTY ? "" : readFileSync(0, "utf8"),
      );
    for (const snapshot of snapshots) {
      if (snapshot !== working) sameChecker(working, snapshot);
      const result = checkSnapshot(snapshot);
      console.log(
        `exposure matrix: CLEAN (${snapshot.label}; ${result.surfaces} surfaces, ${result.sources} reviewed sources)`,
      );
    }
    if (snapshots.length === 0)
      console.log("exposure matrix: no source revisions in deletion-only push");
  } catch (error) {
    console.error(`exposure matrix: FAIL\n${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();

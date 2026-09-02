#!/usr/bin/env node
/**
 * Biome over the files changed since `origin/main` — the `pnpm lint` gate.
 *
 * Biome 1.9's own `--changed --since=origin/main` hands every path the diff
 * names to the checker, deleted ones included, and then fails the run with
 * an internal I/O error for each file that is no longer there. So the list
 * is taken from git here, with deletions and paths no longer on disk
 * filtered out, and an empty list is a pass: nothing changed, nothing to
 * check.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const since = process.env.LINT_SINCE ?? "origin/main";
const listed = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=d", "-z", `${since}...HEAD`],
  { encoding: "utf8" },
);
const staged = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=d", "-z", "HEAD"],
  { encoding: "utf8" },
);
const untracked = execFileSync(
  "git",
  ["ls-files", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);
const files = [
  ...new Set(`${listed}\0${staged}\0${untracked}`.split("\0").filter(Boolean)),
];
if (files.length === 0) {
  console.log("lint: nothing changed since", since);
  process.exit(0);
}
const result = spawnSync(
  "pnpm",
  ["exec", "biome", "check", "--no-errors-on-unmatched", ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);

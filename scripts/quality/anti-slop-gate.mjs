#!/usr/bin/env node
/**
 * Anti-slop ratchet -- the `pnpm lint:anti-slop` gate.
 *
 * The root `oxlint.config.ts` rules are a hard error on any file a commit
 * touches (`pnpm lint:anti-slop:files`, run by `.githooks/pre-commit` on
 * staged files). The tree as a whole carried findings from before the rules
 * were turned on, so the full-repository run records them in
 * `tools/quality/anti-slop-baseline.json` and refuses to let them grow, the way
 * `quality-gate.mjs` ratchets structural debt (ADR 0093):
 *
 *   - a file or rule with no entry is allowed zero
 *   - a count may not rise above its recorded number
 *   - a count that falls must be recorded in the same commit (`--update`)
 *   - an unused disable directive always fails; it is never ledgered
 *
 * Usage:
 *   node scripts/quality/anti-slop-gate.mjs            # check (pnpm verify, pre-push)
 *   node scripts/quality/anti-slop-gate.mjs --update   # record improvements only
 *   node scripts/quality/anti-slop-gate.mjs --seed     # write the first ledger; refuses if one exists
 *
 * `--update` lowers counts, drops entries that reach zero and drops deleted
 * files. It never raises a count or adds an entry, and has no override.
 *
 * Oxlint runs with exactly the flags of `lint:anti-slop:files`, plus JSON
 * output. The file list is the one Oxlint itself resolves for `.` under the
 * config's ignore patterns; it is split across one single-threaded Oxlint
 * process per core, because `anti-slop/no-unsafe-dictionary-type` builds a
 * TypeScript program per file and dominates the run. `ANTI_SLOP_JOBS=<n>`
 * overrides the process count.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateDiagnostics,
  compareLedger,
  ledgerFromCounts,
  serializeLedger,
  tightenLedger,
} from "../lib/anti-slop-ledger.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ledgerPath = join(root, "tools/quality/anti-slop-baseline.json");
const oxlint = join(root, "node_modules", ".bin", "oxlint");
/** The flags of `lint:anti-slop:files` in package.json -- keep them identical. */
const FLAGS = [
  "--config",
  "oxlint.config.ts",
  "--disable-nested-config",
  "--report-unused-disable-directives-severity=error",
  "--deny-warnings",
  "--no-error-on-unmatched-pattern",
];
const LIST_LIMIT = 60;

const args = new Set(process.argv.slice(2));
const update = args.has("--update");
const seed = args.has("--seed");

function lintedFiles() {
  const listed = spawnSync(oxlint, [...FLAGS, "--debug=files", "."], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.error !== undefined || listed.status !== 0) {
    throw new Error(
      `oxlint could not list files: ${listed.error?.message ?? listed.stderr}`,
    );
  }
  return listed.stdout.split("\n").filter((line) => line.trim() !== "");
}

/** Largest files first, each onto the lightest shard. */
function shard(files, count) {
  const shards = Array.from({ length: count }, () => ({ bytes: 0, files: [] }));
  const sized = files
    .map((file) => ({ file, bytes: statSync(join(root, file)).size }))
    .sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
  for (const { file, bytes } of sized) {
    const lightest = shards.reduce((a, b) => (b.bytes < a.bytes ? b : a));
    lightest.bytes += bytes;
    lightest.files.push(file);
  }
  return shards.filter((s) => s.files.length > 0).map((s) => s.files);
}

function lintShard(files) {
  return new Promise((done, fail) => {
    const child = spawn(
      oxlint,
      [...FLAGS, "--format=json", "--threads=1", ...files],
      { cwd: root, env: { ...process.env, NODE_OPTIONS: "" } },
    );
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", fail);
    child.on("close", () => {
      const stdout = Buffer.concat(out).toString("utf8");
      try {
        const report = JSON.parse(stdout);
        if (report.number_of_files !== files.length) {
          throw new Error(
            `linted ${report.number_of_files} of ${files.length} files`,
          );
        }
        done(report.diagnostics ?? []);
      } catch (error) {
        fail(
          new Error(
            `oxlint did not report on its shard (${error.message}).\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${Buffer.concat(err).toString("utf8").slice(0, 2000)}`,
          ),
        );
      }
    });
  });
}

function readLedger() {
  if (!existsSync(ledgerPath)) return null;
  return JSON.parse(readFileSync(ledgerPath, "utf8")).files ?? {};
}

function writeLedger(files) {
  const ledger = serializeLedger(files);
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return ledger;
}

function printList(title, entries, render) {
  console.error(`\n${title}\n`);
  for (const entry of entries.slice(0, LIST_LIMIT))
    console.error(render(entry));
  if (entries.length > LIST_LIMIT) {
    console.error(`  ... and ${entries.length - LIST_LIMIT} more`);
  }
}

const change = ({ file, rule, allowed, count, kind }) =>
  `  ${file}\n      ${rule}: recorded ${allowed}, found ${count}${kind === "increase" || kind === undefined ? "" : ` (${kind})`}`;

const started = Date.now();
const files = lintedFiles();
const jobs = Math.max(
  1,
  Number(process.env.ANTI_SLOP_JOBS) || availableParallelism(),
);
const diagnostics = (
  await Promise.all(shard(files, jobs).map((part) => lintShard(part)))
).flat();
const { counts, unusedDirectives, unrecognized } =
  aggregateDiagnostics(diagnostics);
const measuredTotal = [...counts.values()]
  .flatMap((byRule) => [...byRule.values()])
  .reduce((sum, n) => sum + n, 0);
const seconds = Math.round((Date.now() - started) / 1000);
console.log(
  `anti-slop gate: ${files.length} files linted in ${seconds}s (${jobs} jobs); ${measuredTotal} findings in ${counts.size} files`,
);

let failed = false;
if (unusedDirectives.length > 0) {
  failed = true;
  printList(
    `anti-slop gate: FAIL -- ${unusedDirectives.length} unused disable directive(s); remove them`,
    unusedDirectives,
    (where) => `  ${where}`,
  );
}
if (unrecognized.length > 0) {
  failed = true;
  printList(
    `anti-slop gate: FAIL -- ${unrecognized.length} diagnostic(s) that are not a rule finding`,
    unrecognized,
    (line) => `  ${line}`,
  );
}

const recorded = readLedger();
if (seed) {
  if (recorded !== null) {
    console.error(
      "\nanti-slop gate: refusing to seed -- tools/quality/anti-slop-baseline.json exists.",
      "\nThe ledger is seeded once; after that it only tightens (--update).\n",
    );
    process.exit(1);
  }
  if (failed) process.exit(1);
  const ledger = writeLedger(ledgerFromCounts(counts));
  console.log(
    `anti-slop gate: ledger seeded -- ${ledger.totals.violations} findings across ${ledger.totals.files} files`,
  );
  process.exit(0);
}
if (recorded === null) {
  console.error(
    "\nanti-slop gate: FAIL -- tools/quality/anti-slop-baseline.json is missing\n",
  );
  process.exit(1);
}

const { regressions, improvements } = compareLedger(counts, recorded);
const ledgerTotal = serializeLedger(recorded).totals.violations;
console.log(
  `anti-slop gate: ledger ${ledgerTotal} findings across ${Object.keys(recorded).length} files; ${regressions.length} regression(s), ${improvements.length} unrecorded improvement(s)`,
);

if (update) {
  const tightened = tightenLedger(counts, recorded);
  if (tightened.refused !== undefined) {
    printList(
      `anti-slop gate: refusing to update -- ${tightened.refused.length} count(s) would rise or be added.\n--update only tightens the ledger; rewrite the flagged construct instead.`,
      tightened.refused,
      change,
    );
    console.error("");
    process.exit(1);
  }
  const ledger = writeLedger(tightened.files);
  console.log(
    `anti-slop gate: ledger tightened -- ${ledgerTotal} -> ${ledger.totals.violations} findings across ${ledger.totals.files} files`,
  );
  process.exit(failed ? 1 : 0);
}

if (regressions.length > 0) {
  failed = true;
  printList(
    `anti-slop gate: FAIL -- ${regressions.length} regression(s) against tools/quality/anti-slop-baseline.json.\nRewrite the flagged construct; the ledger is never raised.`,
    regressions,
    change,
  );
}
if (improvements.length > 0) {
  failed = true;
  printList(
    `anti-slop gate: FAIL -- ${improvements.length} improvement(s) not recorded.\nThe ratchet only works if it tightens; commit the tightened ledger with them:\n\n  pnpm lint:anti-slop --update`,
    improvements,
    change,
  );
}
if (failed) {
  console.error("");
  process.exit(1);
}
console.log("anti-slop gate: CLEAN -- no regressions");

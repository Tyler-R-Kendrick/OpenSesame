#!/usr/bin/env node
/**
 * Structural-complexity ratchet -- the `pnpm quality:gate` gate.
 *
 * The repo carries real structural debt: files of 10k+ lines, functions of
 * several hundred, `impl` blocks with 200+ methods. Turning a 400-line budget
 * on as a hard error would fail the whole tree, so nobody would turn it on.
 * This gate takes the other road: it records today's debt in
 * `quality-baseline.json` and then refuses to let it grow.
 *
 *   - a NEW file must satisfy the budget outright (its baseline is zero)
 *   - an EXISTING oversized file may not get worse than its recorded number
 *   - a file that improves must have its baseline tightened in the same commit
 *
 * That last rule is what makes it a ratchet rather than a snapshot: the
 * recorded numbers can only ever go down, so every commit that touches a bad
 * file leaves it better than it found it, and the gate never quietly rots.
 *
 * What is measured:
 *   - TypeScript/TSX/JS -- Oxlint (already a devDependency and already a gate)
 *     via oxlint.complexity.jsonc: max-lines, max-lines-per-function,
 *     complexity (cyclomatic), max-params, max-depth, max-nested-callbacks,
 *     max-statements.
 *   - Rust -- module size only, counted here. Clippy has no per-file lint, so
 *     the same 400-line budget is applied directly to .rs files. Rust
 *     *function* complexity is already gated by clippy.toml +
 *     scripts/clippy-gate.sh and is deliberately not duplicated.
 *
 * Usage:
 *   node scripts/quality-gate.mjs            # check (CI / pnpm verify)
 *   node scripts/quality-gate.mjs --update   # record improvements
 *   node scripts/quality-gate.mjs --update --accept-new-debt
 *                                            # ... and let numbers rise
 *   node scripts/quality-gate.mjs --summary  # worst offenders, no exit code
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILE_SIZE_RULE,
  MAX_LINES,
  measureStructure,
} from "./lib/structure-metrics.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "quality-baseline.json");
const oxlintConfig = join(root, "oxlint.complexity.jsonc");

const args = new Set(process.argv.slice(2));
const update = args.has("--update");
const summaryOnly = args.has("--summary");
const acceptNewDebt = args.has("--accept-new-debt");

function readBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
    return parsed.files ?? {};
  } catch {
    return {};
  }
}

/** Stable, sorted, diff-friendly -- the debt ledger is meant to be read. */
function serializeBaseline(counts) {
  const files = {};
  let violations = 0;
  let oversizedLines = 0;
  for (const file of [...counts.keys()].sort()) {
    const byRule = counts.get(file);
    const rules = {};
    for (const rule of [...byRule.keys()].sort()) {
      rules[rule] = byRule.get(rule);
      // A recorded line count is one oversized file, not N violations -- but
      // then `violations` alone makes a SPLIT look like a regression: one
      // 5,027-line file becomes five smaller ones and the count goes 1 -> 5.
      // `oversizedLines` is the measure that actually falls when debt moves
      // rather than grows, so both are recorded.
      if (rule === FILE_SIZE_RULE) {
        violations += 1;
        oversizedLines += byRule.get(rule);
      } else {
        violations += byRule.get(rule);
      }
    }
    files[file] = rules;
  }
  return {
    $comment: [
      "Structural-complexity debt ledger -- see scripts/quality-gate.mjs.",
      "These numbers may only ever go DOWN. Regenerate with:",
      "  pnpm quality:gate --update",
      "Do not hand-edit, and do not raise a number to make the gate pass.",
      "max-lines records the file's line count; every other rule counts occurrences.",
    ],
    thresholds: {
      "max-lines": MAX_LINES,
      "max-lines-per-function": 100,
      complexity: 15,
      "max-params": 7,
      "max-depth": 4,
      "max-nested-callbacks": 4,
      "max-statements": 40,
    },
    totals: { files: Object.keys(files).length, violations, oversizedLines },
    files,
  };
}

const measured = measureStructure(root, oxlintConfig);
const baseline = readBaseline();

const regressions = [];
const improvements = [];

for (const [file, byRule] of measured) {
  for (const [rule, count] of byRule) {
    const allowed = baseline[file]?.[rule] ?? 0;
    if (count > allowed) regressions.push({ file, rule, allowed, count });
  }
}
for (const [file, rules] of Object.entries(baseline)) {
  for (const [rule, allowed] of Object.entries(rules)) {
    const count = measured.get(file)?.get(rule) ?? 0;
    if (count < allowed) improvements.push({ file, rule, allowed, count });
  }
}

if (summaryOnly) {
  const worst = [...measured.entries()]
    .map(([file, byRule]) => ({
      file,
      total: [...byRule.values()].reduce((sum, n) => sum + n, 0),
      rules: [...byRule.entries()].map(([r, n]) => `${r}x${n}`).join(" "),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 30);
  const ledger = serializeBaseline(measured);
  console.log(
    `quality: ${ledger.totals.violations} violations across ${ledger.totals.files} files\n`,
  );
  for (const { file, total, rules } of worst) {
    console.log(`  ${String(total).padStart(4)}  ${file}  (${rules})`);
  }
  process.exit(0);
}

if (update) {
  // `--update` is the ratchet's only escape hatch, so it must not be able to
  // launder a regression into the ledger. Recording improvements -- the common
  // case -- stays a one-command operation; writing a number UP takes a second,
  // greppable flag, and the raised lines are visible in the baseline's diff.
  if (regressions.length > 0 && !acceptNewDebt) {
    console.error(
      `\nquality gate: refusing to update -- ${regressions.length} recorded number(s) would go UP\n`,
    );
    console.error(
      "The ledger is a ratchet; --update records improvements, it does not accept",
      "\nregressions. Split the file or shrink the function.",
      "\n",
      "\nTwo cases legitimately need the override. Genuinely unavoidable new debt --",
      "\nand RELOCATION: splitting one oversized file into several leaves the pieces",
      "\nlooking like new entries even when nothing got worse. Check the totals line",
      "\nin the baseline diff to tell them apart, then say so explicitly:",
      "\n\n  pnpm quality:gate --update --accept-new-debt\n",
    );
    for (const { file, rule, allowed, count } of regressions
      .sort((a, b) => a.file.localeCompare(b.file))
      .slice(0, 40)) {
      console.error(`  ${file}\n      ${rule}: ${allowed} -> ${count}`);
    }
    if (regressions.length > 40) {
      console.error(`  ... and ${regressions.length - 40} more`);
    }
    console.error("");
    process.exit(1);
  }
  const ledger = serializeBaseline(measured);
  writeFileSync(baselinePath, `${JSON.stringify(ledger, null, 2)}\n`);
  const accepted =
    regressions.length > 0
      ? ` (${regressions.length} new debt accepted via --accept-new-debt)`
      : "";
  console.log(
    `quality gate: baseline updated -- ${ledger.totals.violations} violations across ${ledger.totals.files} files${accepted}`,
  );
  process.exit(0);
}

if (regressions.length > 0) {
  console.error(
    `\nquality gate: FAIL -- ${regressions.length} structural regression(s)\n`,
  );
  console.error(
    "A file grew past what quality-baseline.json allows. Split it, or reduce the",
    "\nfunction, rather than raising the recorded number.\n",
  );
  for (const { file, rule, allowed, count } of regressions
    .sort((a, b) => a.file.localeCompare(b.file))
    .slice(0, 60)) {
    console.error(
      `  ${file}\n      ${rule}: allowed ${allowed}, found ${count}`,
    );
  }
  if (regressions.length > 60) {
    console.error(`  ... and ${regressions.length - 60} more`);
  }
  console.error("");
  process.exit(1);
}

if (improvements.length > 0) {
  console.error(
    `\nquality gate: FAIL -- ${improvements.length} improvement(s) not recorded\n`,
  );
  console.error(
    "The ratchet only works if it tightens. These files got better; commit the",
    "\ntightened baseline alongside them:\n\n  pnpm quality:gate --update\n",
  );
  for (const { file, rule, allowed, count } of improvements
    .sort((a, b) => a.file.localeCompare(b.file))
    .slice(0, 60)) {
    console.error(`  ${file}\n      ${rule}: ${allowed} -> ${count}`);
  }
  if (improvements.length > 60) {
    console.error(`  ... and ${improvements.length - 60} more`);
  }
  console.error("");
  process.exit(1);
}

const ledger = serializeBaseline(measured);
console.log(
  `quality gate: CLEAN -- ${ledger.totals.violations} tracked violations across ${ledger.totals.files} files (no regressions)`,
);

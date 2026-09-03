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
 *   node scripts/quality-gate.mjs --update   # re-record the baseline
 *   node scripts/quality-gate.mjs --summary  # worst offenders, no exit code
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "quality-baseline.json");
const oxlintConfig = join(root, "oxlint.complexity.jsonc");

const MAX_LINES = 400;
/**
 * `max-lines` is stored differently from every other rule in the baseline.
 *
 * The others count occurrences, and one occurrence of "this file is too long"
 * carries no information about HOW long. Recording a bare 1 made the ratchet
 * blind to the work that matters most: splitting a 10,601-line module down to
 * 2,275 left the count at 1, so the gate reported no improvement and the
 * baseline never tightened. So for this rule the recorded number is the file's
 * actual line count, and the ratchet tracks every line removed.
 */
const FILE_SIZE_RULE = "max-lines";
/** Vendored third-party trees. Their size is not ours to ratchet. */
const IGNORED_PREFIXES = [
  ".agents/",
  ".claude/",
  ".codex/",
  ".cursor/",
  "skills/install-anti-slop/",
];

const args = new Set(process.argv.slice(2));
const update = args.has("--update");
const summaryOnly = args.has("--summary");

/** @returns {Map<string, Map<string, number>>} file -> rule -> count */
function measureTypeScript() {
  const result = spawnSync(
    join(root, "node_modules", ".bin", "oxlint"),
    [
      "--config",
      oxlintConfig,
      "--format=json",
      "--no-error-on-unmatched-pattern",
      // Single-threaded so the diagnostic set is byte-identical run to run.
      "--threads=1",
      ".",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error !== undefined) {
    throw new Error(`oxlint failed to start: ${result.error.message}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `oxlint did not emit JSON.\nstdout: ${result.stdout.slice(0, 2000)}\nstderr: ${result.stderr.slice(0, 2000)}`,
    );
  }
  const counts = new Map();
  for (const diagnostic of report.diagnostics ?? []) {
    const rule = /^eslint\((?<name>[a-z-]+)\)$/.exec(diagnostic.code)?.groups
      ?.name;
    if (rule === undefined) continue;
    const file = normalize(diagnostic.filename);
    if (isIgnored(file)) continue;
    if (rule === FILE_SIZE_RULE) {
      // Record how long the file actually is, not that it is merely too long --
      // see the note on FILE_SIZE_RULE.
      const measured = /\((?<lines>\d+)\)/.exec(diagnostic.message)?.groups
        ?.lines;
      set(counts, file, rule, Number(measured ?? 0));
      continue;
    }
    bump(counts, file, rule);
  }
  return counts;
}

/**
 * @returns {Map<string, Map<string, number>>} file -> rule -> count
 *
 * `--others --exclude-standard` alongside `--cached` is load-bearing: a plain
 * `git ls-files` lists only TRACKED files, so a newly written module escaped
 * the budget until the commit that added it and then failed the run after.
 * That is exactly backwards -- new files are the ones that must meet the
 * budget outright. Oxlint already walks the working tree for the TypeScript
 * side; this makes Rust behave the same. `--exclude-standard` keeps
 * .gitignore'd build output out.
 */
function measureRust() {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.rs"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const counts = new Map();
  for (const file of new Set(listed.split("\0").filter(Boolean))) {
    if (isIgnored(file)) continue;
    let source;
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // listed in the index but not on disk
    }
    const length = lineCount(source);
    if (length > MAX_LINES) set(counts, file, FILE_SIZE_RULE, length);
  }
  return counts;
}

/**
 * Lines as Oxlint's max-lines counts them: a trailing newline does not open a
 * further line, and a wholly empty file is zero rather than one.
 */
function lineCount(source) {
  if (source === "") return 0;
  const withoutTrailingNewline = source.endsWith("\n")
    ? source.slice(0, -1)
    : source;
  return withoutTrailingNewline.split("\n").length;
}

function normalize(filename) {
  return filename.replace(/^\.\//, "").replaceAll("\\", "/");
}

function isIgnored(file) {
  return IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function set(counts, file, rule, value) {
  let byRule = counts.get(file);
  if (byRule === undefined) {
    byRule = new Map();
    counts.set(file, byRule);
  }
  byRule.set(rule, value);
}

function bump(counts, file, rule) {
  let byRule = counts.get(file);
  if (byRule === undefined) {
    byRule = new Map();
    counts.set(file, byRule);
  }
  byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
}

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
  for (const file of [...counts.keys()].sort()) {
    const byRule = counts.get(file);
    const rules = {};
    for (const rule of [...byRule.keys()].sort()) {
      rules[rule] = byRule.get(rule);
      // A recorded line count is one oversized file, not N violations.
      violations += rule === FILE_SIZE_RULE ? 1 : byRule.get(rule);
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
    totals: { files: Object.keys(files).length, violations },
    files,
  };
}

/** Merge without letting one measurer silently shadow the other's file. */
function merge(...sources) {
  const merged = new Map();
  for (const source of sources) {
    for (const [file, byRule] of source) {
      let target = merged.get(file);
      if (target === undefined) {
        target = new Map();
        merged.set(file, target);
      }
      for (const [rule, count] of byRule) {
        // TS and Rust file sets are disjoint, but a size is a measurement and
        // must never be summed the way an occurrence tally is.
        target.set(
          rule,
          rule === FILE_SIZE_RULE ? count : (target.get(rule) ?? 0) + count,
        );
      }
    }
  }
  return merged;
}

const measured = merge(measureTypeScript(), measureRust());
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
  writeFileSync(
    baselinePath,
    `${JSON.stringify(serializeBaseline(measured), null, 2)}\n`,
  );
  const ledger = serializeBaseline(measured);
  console.log(
    `quality gate: baseline updated -- ${ledger.totals.violations} violations across ${ledger.totals.files} files`,
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

/**
 * Structural measurement -- the numbers `scripts/quality-gate.mjs` ratchets.
 *
 * Split out when quality-gate.mjs crossed the very 400-line budget it
 * enforces. Measuring and ratcheting are separate jobs: this module knows how
 * to read Oxlint and count Rust lines, and nothing about baselines.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** @returns {Map<string, Map<string, number>>} file -> rule -> count */
function measureTypeScript(root, oxlintConfig) {
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
      // see the note on FILE_SIZE_RULE. The count is parsed out of Oxlint's
      // prose ("File has too many lines (418)."), so a wording change upstream
      // would silently yield 0 here: every oversized file would read as an
      // improvement, the baseline would be tightened to 0, and the gate would
      // then pass forever while measuring nothing. Fail loudly instead.
      const measured = /\((?<lines>\d+)\)/.exec(diagnostic.message)?.groups
        ?.lines;
      if (measured === undefined) {
        throw new Error(
          [
            `Cannot read a line count from Oxlint's ${FILE_SIZE_RULE} message: ${JSON.stringify(diagnostic.message)}`,
            "Oxlint's wording probably changed. Fix the parser in scripts/quality-gate.mjs;",
            "do not let this fall back to zero, which would blind the gate.",
          ].join("\n"),
        );
      }
      set(counts, file, rule, Number(measured));
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
function measureRust(root) {
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

/** @returns {Map<string, Map<string, number>>} file -> rule -> measurement */
export function measureStructure(root, oxlintConfig) {
  return merge(measureTypeScript(root, oxlintConfig), measureRust(root));
}

export { FILE_SIZE_RULE, MAX_LINES };

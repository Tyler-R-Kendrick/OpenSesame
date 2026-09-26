/**
 * The anti-slop debt ledger -- what `scripts/quality/anti-slop-gate.mjs` ratchets.
 *
 * Pure: it reads Oxlint's JSON diagnostics and a recorded ledger, and knows
 * nothing about processes or files on disk. The gate script runs Oxlint and
 * writes the ledger; everything that decides pass or fail lives here, so the
 * decision is unit-tested (`anti-slop-ledger.test.mjs`).
 *
 * The ledger is keyed file -> rule -> count. A file or rule with no entry is
 * allowed zero, so new code meets every rule outright. Recorded numbers only
 * fall: a count above its entry fails, and so does a count below it until the
 * ledger is tightened in the same commit. Unused disable directives are never
 * ledgered; they always fail, as `pnpm lint:anti-slop:files` fails them.
 */

/** Oxlint prints this for a directive that suppressed nothing. */
const UNUSED_DIRECTIVE = /^Unused (?:eslint|oxlint)-disable directive/;
/** `anti-slop(no-runtime-typeof)` -> `anti-slop/no-runtime-typeof`. */
const RULE_CODE = /^(?<plugin>[a-z0-9-]+)\((?<rule>[a-z0-9-]+)\)$/;

const normalizePath = (path) => path.replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * Oxlint's JSON diagnostics -> per-file, per-rule counts. A diagnostic that is
 * neither a rule finding nor an unused directive (a parse error, a plugin that
 * failed to load) is returned in `unrecognized`: the gate cannot ledger what it
 * cannot name, so it fails on it.
 *
 * @returns {{ counts: Map<string, Map<string, number>>,
 *   unusedDirectives: string[], unrecognized: string[] }}
 */
export function aggregateDiagnostics(diagnostics) {
  const counts = new Map();
  const unusedDirectives = [];
  const unrecognized = [];
  for (const diagnostic of diagnostics) {
    const file = normalizePath(diagnostic.filename ?? "");
    const line = diagnostic.labels?.[0]?.span?.line;
    const where = line === undefined ? file : `${file}:${line}`;
    if (UNUSED_DIRECTIVE.test(diagnostic.message ?? "")) {
      unusedDirectives.push(where);
      continue;
    }
    const code = RULE_CODE.exec(diagnostic.code ?? "")?.groups;
    if (code === undefined) {
      unrecognized.push(`${where}: ${diagnostic.message}`);
      continue;
    }
    const rule = `${code.plugin}/${code.rule}`;
    if (!counts.has(file)) counts.set(file, new Map());
    const byRule = counts.get(file);
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }
  return { counts, unusedDirectives, unrecognized };
}

/**
 * Measured counts against the recorded ledger (`files` of the JSON).
 *
 * `regressions` -- a count above its entry, or a file or rule with no entry.
 * `improvements` -- a recorded count the tree now beats, including a file that
 * no longer exists or no longer has findings (measured as zero).
 */
export function compareLedger(measured, recorded) {
  const regressions = [];
  const improvements = [];
  for (const [file, byRule] of measured) {
    for (const [rule, count] of byRule) {
      const allowed = recorded[file]?.[rule];
      if (allowed === undefined) {
        const kind = recorded[file] === undefined ? "new-file" : "new-rule";
        regressions.push({ file, rule, allowed: 0, count, kind });
      } else if (count > allowed) {
        regressions.push({ file, rule, allowed, count, kind: "increase" });
      }
    }
  }
  for (const [file, rules] of Object.entries(recorded)) {
    for (const [rule, allowed] of Object.entries(rules)) {
      const count = measured.get(file)?.get(rule) ?? 0;
      if (count < allowed) improvements.push({ file, rule, allowed, count });
    }
  }
  const byPlace = (a, b) =>
    a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule);
  return {
    regressions: regressions.sort(byPlace),
    improvements: improvements.sort(byPlace),
  };
}

/**
 * The tightened ledger `--update` writes: every recorded count lowered to what
 * was measured, entries at zero dropped, files with no entries left dropped.
 * It never raises a count and never adds an entry -- given any regression it
 * refuses and returns the regressions instead of a ledger.
 *
 * @returns {{ files: Record<string, Record<string, number>> } |
 *   { refused: ReturnType<typeof compareLedger>["regressions"] }}
 */
export function tightenLedger(measured, recorded) {
  const { regressions } = compareLedger(measured, recorded);
  if (regressions.length > 0) return { refused: regressions };
  const files = {};
  for (const file of Object.keys(recorded).sort()) {
    const rules = {};
    for (const rule of Object.keys(recorded[file]).sort()) {
      const count = Math.min(
        recorded[file][rule],
        measured.get(file)?.get(rule) ?? 0,
      );
      if (count > 0) rules[rule] = count;
    }
    if (Object.keys(rules).length > 0) files[file] = rules;
  }
  return { files };
}

/** The measured counts as a ledger `files` object -- used only to seed one. */
export function ledgerFromCounts(measured) {
  const files = {};
  for (const file of [...measured.keys()].sort()) {
    const byRule = measured.get(file);
    const rules = {};
    for (const rule of [...byRule.keys()].sort())
      rules[rule] = byRule.get(rule);
    files[file] = rules;
  }
  return files;
}

/** Stable, sorted, diff-friendly -- the ledger is meant to be read. */
export function serializeLedger(files) {
  const byRule = {};
  let violations = 0;
  for (const rules of Object.values(files)) {
    for (const [rule, count] of Object.entries(rules)) {
      byRule[rule] = (byRule[rule] ?? 0) + count;
      violations += count;
    }
  }
  const sortedByRule = {};
  for (const rule of Object.keys(byRule).sort()) {
    sortedByRule[rule] = byRule[rule];
  }
  return {
    $comment: [
      "Anti-slop debt ledger -- see scripts/quality/anti-slop-gate.mjs (pnpm lint:anti-slop).",
      "Findings of the root oxlint.config.ts rules that the tree carried when the full-repo",
      "gate was turned on, per file and rule. These numbers may only ever go DOWN:",
      "a file or rule with no entry is allowed zero, and a count that falls must be",
      "recorded in the same commit with:",
      "  pnpm lint:anti-slop --update",
      "--update never raises a count or adds an entry. Do not hand-edit to make the gate pass;",
      "rewrite the flagged construct. Staged files are held to zero by the pre-commit hook",
      "(pnpm lint:anti-slop:files), so a file someone touches leaves this ledger.",
    ],
    totals: {
      files: Object.keys(files).length,
      violations,
      byRule: sortedByRule,
    },
    files,
  };
}

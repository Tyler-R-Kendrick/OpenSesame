#!/usr/bin/env node
/**
 * Log hygiene -- the gate that keeps every log line behind the scrubber
 * (ADR 0157).
 *
 *   node scripts/quality/log-hygiene-gate.mjs            # check
 *   node scripts/quality/log-hygiene-gate.mjs --update   # record improvements only
 *   node scripts/quality/log-hygiene-gate.mjs --update --accept-new-debt
 *                                                        # also record sites a widened detector
 *                                                        # newly counts (file/kind with no entry);
 *                                                        # never raises a recorded number
 *   node scripts/quality/log-hygiene-gate.mjs --seed     # write the first ledger; refuses if one exists
 *
 * Counts, per file, the ways production code goes around the shared logger:
 * `console.*` (called, passed as a value or indexed), a hand-built `pino(...)`
 * (aliased or `.default(...)` too), a direct `process.stdout/stderr.write` and a
 * tracing subscriber or fmt layer built without the scrubbing writer. A file or kind with no entry is allowed zero,
 * so new code meets the rule outright; a recorded number only falls
 * (`tools/quality/log-hygiene-baseline.json`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareHygiene,
  isProductionRust,
  isProductionTypeScript,
  ledgerOf,
  rustBypasses,
  typeScriptBypasses,
} from "../lib/log-hygiene.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baselinePath = resolve(root, "tools/quality/log-hygiene-baseline.json");
const update = process.argv.includes("--update");
const seed = process.argv.includes("--seed");
const acceptNewDebt = process.argv.includes("--accept-new-debt");

const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((path) => existsSync(resolve(root, path)));

const found = {};
for (const path of tracked) {
  const typeScript = isProductionTypeScript(path);
  if (!typeScript && !isProductionRust(path)) continue;
  const text = readFileSync(resolve(root, path), "utf8");
  found[path] = typeScript
    ? typeScriptBypasses(path, text)
    : rustBypasses(text);
}

const recorded = JSON.parse(readFileSync(baselinePath, "utf8")).files ?? {};
const { regressions, improvements } = compareHygiene(found, recorded);

if (seed) {
  if (Object.keys(recorded).length > 0) {
    console.error(
      "log hygiene: a ledger exists; --seed refuses to overwrite it",
    );
    process.exit(1);
  }
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ files: ledgerOf(found) }, null, 2)}\n`,
  );
  console.log("log hygiene: ledger seeded");
  process.exit(0);
}

if (update) {
  // A widened detector counts sites no entry covers yet; those alone may be
  // accepted. A number that is already recorded is never raised.
  const raised = regressions.filter((r) => r.allowed > 0);
  if (regressions.length > 0 && !(acceptNewDebt && raised.length === 0)) {
    console.error(
      "log hygiene: refusing to record a regression; fix it instead",
    );
  } else {
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ files: ledgerOf(found) }, null, 2)}\n`,
    );
    console.log(
      `log hygiene: baseline updated -- ${improvements.length} improvement(s), ${regressions.length} newly counted site(s) accepted`,
    );
    process.exit(0);
  }
}

for (const r of regressions) {
  console.error(
    `  ${r.file}\n      ${r.kind}: allowed ${r.allowed}, found ${r.now}`,
  );
}
for (const i of improvements) {
  console.error(
    `  ${i.file}\n      ${i.kind}: recorded ${i.allowed}, now ${i.now} (tighten the ledger)`,
  );
}
if (regressions.length > 0) {
  console.error(
    "\nlog hygiene: FAIL -- a call site goes around the scrubbing logger. Use createLogger (TypeScript) or the scrubbing writer (Rust); the ledger is never raised.",
  );
  process.exit(1);
}
if (improvements.length > 0) {
  console.error(
    "\nlog hygiene: improvements must be recorded: node scripts/quality/log-hygiene-gate.mjs --update",
  );
  process.exit(1);
}
console.log(
  `log hygiene: CLEAN -- ${Object.keys(ledgerOf(found)).length} file(s) carry recorded bypasses, none new`,
);

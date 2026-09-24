#!/usr/bin/env node
/**
 * Regenerate the two indexes that grow with every change:
 *
 *   docs/adr/README.md              one row per ADR: number, title, status
 *   docs/security/audits/README.md  one row per audit: date, title
 *
 * Each file keeps a hand-written preamble above the generated marker; only
 * the table below it is rewritten.
 *
 *   node scripts/docs-index.mjs          # rewrite both indexes
 *   node scripts/docs-index.mjs --check  # exit 1 if either is stale
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adrRow, auditRow, renderIndex } from "./lib/docs-index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const indexes = [
  {
    dir: join(root, "docs", "adr"),
    pattern: /^\d{4}-.+\.md$/u,
    header: ["ADR", "Decision", "Status"],
    row: adrRow,
  },
  {
    dir: join(root, "docs", "security", "audits"),
    pattern: /^\d{4}-\d{2}-\d{2}(?:-.+)?\.md$/u,
    header: ["Date", "Audit"],
    row: auditRow,
  },
];

let stale = 0;
for (const index of indexes) {
  const readme = join(index.dir, "README.md");
  const names = readdirSync(index.dir)
    .filter((name) => index.pattern.test(name))
    .sort();
  const rows = names.map((name) =>
    index.row(name, readFileSync(join(index.dir, name), "utf8")),
  );
  const current = readFileSync(readme, "utf8");
  const next = renderIndex(current, index.header, rows);
  if (next === current) continue;
  stale += 1;
  if (process.argv.includes("--check")) {
    console.log(`${readme}: stale — run node scripts/docs-index.mjs`);
  } else {
    writeFileSync(readme, next);
    console.log(`${readme}: ${rows.length} rows`);
  }
}
if (process.argv.includes("--check")) process.exit(stale === 0 ? 0 : 1);
if (stale === 0) console.log("docs indexes current");

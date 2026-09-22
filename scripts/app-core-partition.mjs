#!/usr/bin/env node
/**
 * Report what stands between Pages and the app-core relocation (ADR 0133).
 *
 *   node scripts/app-core-partition.mjs            # report, exit 0
 *   node scripts/app-core-partition.mjs --check    # exit 1 on any crossing or React import
 *   node scripts/app-core-partition.mjs --json     # machine-readable report
 *
 * `--check` is the step-3 gate: the relocation runs only when moving code no
 * longer imports staying code or React. Imports that reach outside `src`
 * (public assets, fixtures, scripts) are listed for the relocation script to
 * rewrite; `import.meta.env` uses are listed for step 2, which replaces them
 * with the runtime env port.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClassifier, findViolations } from "./lib/app-core-partition.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(repo, "apps/pages/app-core.partition.json"), "utf8"),
);
const root = join(repo, manifest.root);
const argv = new Set(process.argv.slice(2));

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css|json)$/.test(entry.name)) {
      out.set(relative(root, full).split("\\").join("/"), full);
    }
  }
  return out;
}

const paths = walk(root, new Map());
const files = new Map();
for (const [path, full] of paths) {
  files.set(path, /\.(ts|tsx)$/.test(path) ? readFileSync(full, "utf8") : "");
}
const classify = createClassifier(manifest);
const { crossings, outside, react, viteEnv } = findViolations(files, classify);

const TEST = /(\.test\.|\.property\.|__tests__\/|\.fixture\.)/;
const tally = { source: [0, 0], test: [0, 0] };
for (const [path, source] of files) {
  if (!/\.tsx?$/.test(path) || classify(path) !== "move") continue;
  const bucket = TEST.test(path) ? tally.test : tally.source;
  bucket[0] += 1;
  bucket[1] += source.split("\n").length;
}

if (argv.has("--json")) {
  console.log(
    JSON.stringify({ tally, crossings, outside, react, viteEnv }, null, 2),
  );
} else {
  console.log(
    `app-core partition: ${tally.source[0]} source files (${tally.source[1]} lines) ` +
      `and ${tally.test[0]} test files (${tally.test[1]} lines) move\n` +
      `  ${crossings.length} crossing edge(s), ${react.length} React/tsx import(s), ` +
      `${outside.length} import(s) outside src, ${viteEnv.length} import.meta.env user(s)`,
  );
  const show = (title, rows, fmt) => {
    if (rows.length === 0) return;
    console.log(`\n${title}`);
    for (const row of rows) console.log(`  ${fmt(row)}`);
  };
  const edge = ({ from, to, typeOnly }) =>
    `${from} -> ${to}${typeOnly ? " (type)" : ""}`;
  show("moving code → staying code:", crossings, edge);
  show("moving code → React / .tsx:", react, edge);
  show("moving code → files outside src (paths to rewrite):", outside, edge);
  show("import.meta.env (step 2):", viteEnv, (path) => path);
}

if (argv.has("--check") && crossings.length + react.length > 0) {
  process.exit(1);
}

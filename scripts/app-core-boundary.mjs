#!/usr/bin/env node
/**
 * The app-core boundary check (ADR 0133).
 *
 *   node scripts/app-core-boundary.mjs           # report, exit 0
 *   node scripts/app-core-boundary.mjs --check   # exit 1 on any violation
 *   node scripts/app-core-boundary.mjs --json    # machine-readable report
 *
 * packages/app-core may not reach into an app or another package by relative
 * path, load React, read `import.meta.env`, import a Vite virtual module or
 * import itself by name. See scripts/lib/app-core-boundary.mjs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockingCount, findViolations } from "./lib/app-core-boundary.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(repo, "packages/app-core");
const argv = new Set(process.argv.slice(2));

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full, out);
    } else if (/\.(ts|mts|mjs)$/.test(entry.name)) {
      out.set(
        relative(root, full).split("\\").join("/"),
        readFileSync(full, "utf8"),
      );
    }
  }
  return out;
}

const files = walk(join(root, "src"), new Map());
const report = findViolations(files, {
  packageName: "@opensesame/app-core",
  packageDepth: 2,
});

if (argv.has("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const edge = ({ from, to, typeOnly }) =>
    `${from} -> ${to}${typeOnly ? " (type)" : ""}`;
  console.log(
    `app-core boundary: ${files.size} files, ${blockingCount(report)} violation(s) ` +
      `(${report.reactTypes.length} type-only React import(s) allowed)`,
  );
  const show = (title, rows, fmt) => {
    if (rows.length === 0) return;
    console.log(`\n${title}`);
    for (const row of rows) console.log(`  ${fmt(row)}`);
  };
  show("relative imports leaving the package:", report.escapes, edge);
  show("React value imports:", report.react, edge);
  show("import.meta.env (read env() instead):", report.viteEnv, (p) => p);
  show("virtual modules (take them from the host):", report.virtual, edge);
  show(
    "self-imports by package name (use a relative path):",
    report.selfImports,
    edge,
  );
}

if (argv.has("--check") && blockingCount(report) > 0) process.exit(1);

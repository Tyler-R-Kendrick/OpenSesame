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
 * import itself by name; only the Node host and tests may import `node:*`.
 * Outside the browser host, worker entries and tests it may use only the
 * runtime contract — every other browser global is a port. See
 * scripts/lib/app-core-boundary.mjs and scripts/lib/app-core-portability.mjs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockingCount, findViolations } from "./lib/app-core-boundary.mjs";
import {
  findBrowserGlobals,
  mustBePortable,
} from "./lib/app-core-portability.mjs";

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
report.browserGlobals = findBrowserGlobals(
  join(root, "tsconfig.json"),
  (fileName) => mustBePortable(relative(root, fileName).split("\\").join("/")),
).map(({ file, line, name }) => ({
  file: relative(root, file).split("\\").join("/"),
  line,
  name,
}));
const blocking = blockingCount(report) + report.browserGlobals.length;

if (argv.has("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const edge = ({ from, to, typeOnly }) =>
    `${from} -> ${to}${typeOnly ? " (type)" : ""}`;
  console.log(
    `app-core boundary: ${files.size} files, ${blocking} violation(s) ` +
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
  show(
    "Node built-ins outside src/node (use a port):",
    report.nodeImports,
    edge,
  );
  show(
    "browser globals outside src/browser (use a port):",
    report.browserGlobals,
    ({ file, line, name }) => `${file}:${line} ${name}`,
  );
}

if (argv.has("--check") && blocking > 0) process.exit(1);

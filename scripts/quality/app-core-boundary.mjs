#!/usr/bin/env node
/**
 * The shared-core boundary check (ADR 0133), for `@opensesame/app-core` and
 * the vault format kernel `@opensesame/vault-core`.
 *
 *   node scripts/quality/app-core-boundary.mjs           # report, exit 0
 *   node scripts/quality/app-core-boundary.mjs --check   # exit 1 on any violation
 *   node scripts/quality/app-core-boundary.mjs --update  # record a shrunken ledger
 *   node scripts/quality/app-core-boundary.mjs --json    # machine-readable report
 *
 * Neither package may reach into an app or another package by relative
 * path, load React, read `import.meta.env`, import a Vite virtual module or
 * import itself by name; only the Node host and tests may import `node:*`.
 * Outside the browser host, worker entries and tests they may use only the
 * runtime contract — every other browser global is a port (vault-core has
 * no browser host, so none at all). No static import cycle may exist, and
 * app-core's lazy cycle edges only shrink (`layering-baseline.json`). See
 * scripts/lib/app-core-{boundary,portability,layering}.mjs.
 *
 * A third check runs over the whole repository, not one package: a seam a
 * module exports for its owner and tests alone (`app-core-seams.mjs`, ADR 0160
 * §5a) may be imported by no one else, in any package or app.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockingCount, findViolations } from "../lib/app-core-boundary.mjs";
import { compareLedger, layeringReport } from "../lib/app-core-layering.mjs";
import {
  findBrowserGlobals,
  mustBePortable,
} from "../lib/app-core-portability.mjs";
import {
  RESTRICTED_SEAMS,
  findRestrictedImports,
} from "../lib/app-core-seams.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = new Set(process.argv.slice(2));
const PACKAGES = [
  { dir: "packages/app-core", name: "@opensesame/app-core" },
  { dir: "packages/vault-core", name: "@opensesame/vault-core" },
];

function walk(root, dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(root, full, out);
    } else if (/\.(ts|mts|mjs)$/.test(entry.name)) {
      out.set(posix(relative(root, full)), readFileSync(full, "utf8"));
    }
  }
  return out;
}

const posix = (path) => path.split("\\").join("/");

function ledgerOf(root) {
  try {
    const recorded = JSON.parse(
      readFileSync(join(root, "layering-baseline.json"), "utf8"),
    );
    return recorded.lazyCycleEdges ?? [];
  } catch {
    return [];
  }
}

function checkPackage({ dir, name }) {
  const root = join(repo, dir);
  const files = walk(root, join(root, "src"), new Map());
  const report = findViolations(files, { packageName: name, packageDepth: 2 });
  report.browserGlobals = findBrowserGlobals(
    join(root, "tsconfig.json"),
    (fileName) => mustBePortable(posix(relative(root, fileName))),
  ).map(({ file, line, name: global }) => ({
    file: posix(relative(root, file)),
    line,
    name: global,
  }));
  const layering = layeringReport(files);
  const ledger = compareLedger(layering.lazyCycleEdges, ledgerOf(root));
  report.staticCycles = layering.staticCycles;
  report.newLazyCycleEdges = ledger.added;
  report.goneLazyCycleEdges = ledger.removed;
  report.lazyCycleEdges = layering.lazyCycleEdges;
  return { name, root, files: files.size, report };
}

function blockingOf(report) {
  return (
    blockingCount(report) +
    report.browserGlobals.length +
    report.staticCycles.length +
    report.newLazyCycleEdges.length +
    report.goneLazyCycleEdges.length
  );
}

const edge = ({ from, to, typeOnly }) =>
  `${from} -> ${to}${typeOnly ? " (type)" : ""}`;

const SECTIONS = [
  ["relative imports leaving the package:", "escapes", edge],
  ["React value imports:", "react", edge],
  ["import.meta.env (read env() instead):", "viteEnv", (p) => p],
  ["virtual modules (take them from the host):", "virtual", edge],
  ["self-imports by package name (use a relative path):", "selfImports", edge],
  ["Node built-ins outside src/node (use a port):", "nodeImports", edge],
  [
    "browser globals outside the browser host (use a port):",
    "browserGlobals",
    ({ file, line, name }) => `${file}:${line} ${name}`,
  ],
  ["static import cycles:", "staticCycles", (c) => c.join(" -> ")],
  ["new lazy cycle edges (break the loop):", "newLazyCycleEdges", (e) => e],
  [
    "lazy cycle edges gone (record with --update):",
    "goneLazyCycleEdges",
    (e) => e,
  ],
];

function print({ name, files, report }) {
  console.log(
    `${name} boundary: ${files} files, ${blockingOf(report)} violation(s) ` +
      `(${report.reactTypes.length} type-only React import(s) allowed, ` +
      `${report.lazyCycleEdges.length} lazy cycle edge(s) on the ledger)`,
  );
  for (const [title, key, format] of SECTIONS) {
    const rows = report[key];
    if (rows.length === 0) continue;
    console.log(`\n${title}`);
    for (const row of rows) console.log(`  ${format(row)}`);
  }
}

/** Repo-wide: every source file that mentions a restricted seam's module, read once. */
function restrictedSeamReport() {
  const modules = RESTRICTED_SEAMS.map((seam) => seam.module.split("/").pop());
  let listed = "";
  try {
    listed = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "-I",
        "--untracked",
        ...modules.flatMap((name) => ["-e", name]),
        "--",
        "*.ts",
        "*.tsx",
        "*.mts",
        "*.mjs",
        "*.js",
      ],
      { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    // `git grep` exits 1 when nothing matches, which is a clean report.
    if (error.status !== 1) throw error;
  }
  const files = new Map();
  for (const path of listed.split("\n").filter(Boolean)) {
    files.set(path, readFileSync(join(repo, path), "utf8"));
  }
  return findRestrictedImports(files);
}

const results = PACKAGES.map(checkPackage);
const restricted = restrictedSeamReport();
if (argv.has("--update")) {
  for (const { root, report } of results) {
    if (report.newLazyCycleEdges.length > 0) continue;
    const path = join(root, "layering-baseline.json");
    const ledger = { lazyCycleEdges: report.lazyCycleEdges };
    writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
    report.goneLazyCycleEdges = [];
  }
}
if (argv.has("--json")) {
  console.log(JSON.stringify({ results, restricted }, null, 2));
} else {
  for (const result of results) print(result);
  console.log(
    `restricted seams: ${restricted.length} violation(s) ` +
      `(${RESTRICTED_SEAMS.length} seam(s) held to their owners and tests)`,
  );
  for (const { file, module, names } of restricted) {
    console.log(`  ${file} imports ${names.join(", ")} from ${module}`);
  }
}
const blocking =
  results.reduce((sum, r) => sum + blockingOf(r.report), 0) + restricted.length;
if (argv.has("--check") && blocking > 0) process.exit(1);

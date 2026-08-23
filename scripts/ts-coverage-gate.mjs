import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(root, "coverage", "typescript");
const thresholds = {
  branches: Number(process.env.TS_COVERAGE_BRANCHES ?? 88),
  functions: Number(process.env.TS_COVERAGE_FUNCTIONS ?? 94),
  lines: Number(process.env.TS_COVERAGE_LINES ?? 95),
  statements: Number(process.env.TS_COVERAGE_STATEMENTS ?? 94),
};
const packageLinesFloor = Number(process.env.TS_COVERAGE_PACKAGE_LINES ?? 50);

rmSync(outputRoot, { recursive: true, force: true });

const candidates = ["apps", "packages"]
  .flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, group, entry.name)),
  )
  .sort();

const packages = [];
const unmeasured = [];
for (const directory of candidates) {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
  } catch {
    continue;
  }
  const test = manifest.scripts?.test;
  if (test === undefined || test === "") continue;
  if (test.includes?.("vitest run") === true) {
    packages.push(directory);
  } else {
    unmeasured.push({ directory, test });
  }
}

if (unmeasured.length > 0) {
  console.error(
    "\nWARNING: workspace packages with a test script NOT measured by this gate",
  );
  console.error(
    "(their test scripts do not run `vitest run`; coverage here excludes them):",
  );
  for (const { directory, test } of unmeasured) {
    console.error(`  - ${relative(root, directory)} (test: ${test})`);
  }
  console.error("");
}

for (const directory of packages) {
  const name = relative(root, directory).replaceAll("/", "-");
  console.log(`\n==> TypeScript coverage: ${relative(root, directory)}`);
  const result = spawnSync(
    "pnpm",
    [
      "--dir",
      directory,
      "exec",
      "vitest",
      "run",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.include=src/**/*.{ts,tsx}",
      "--coverage.reporter=json",
      `--coverage.reportsDirectory=${join(outputRoot, name)}`,
    ],
    { cwd: root, env: process.env, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function tally(coverage) {
  const counts = {
    branches: [0, 0],
    functions: [0, 0],
    lines: [0, 0],
    statements: [0, 0],
  };
  for (const file of Object.values(coverage)) {
    const statements = Object.entries(file.s);
    counts.statements[0] += statements.filter(([, hits]) => hits > 0).length;
    counts.statements[1] += statements.length;

    const functions = Object.entries(file.f);
    counts.functions[0] += functions.filter(([, hits]) => hits > 0).length;
    counts.functions[1] += functions.length;

    const branches = Object.values(file.b).flat();
    counts.branches[0] += branches.filter((hits) => hits > 0).length;
    counts.branches[1] += branches.length;

    const lines = new Map();
    for (const [id, hits] of statements) {
      const line = file.statementMap[id].start.line;
      lines.set(line, Math.max(lines.get(line) ?? 0, hits));
    }
    counts.lines[0] += [...lines.values()].filter((hits) => hits > 0).length;
    counts.lines[1] += lines.size;
  }
  return counts;
}

function percentage([covered, total]) {
  return total === 0 ? 100 : (covered / total) * 100;
}

const coverage = {};
const perPackage = [];
for (const directory of packages) {
  const name = relative(root, directory).replaceAll("/", "-");
  const report = join(outputRoot, name, "coverage-final.json");
  const packageCoverage = JSON.parse(readFileSync(report, "utf8"));
  Object.assign(coverage, packageCoverage);
  perPackage.push({
    directory: relative(root, directory),
    lines: percentage(tally(packageCoverage).lines),
  });
}

let failed = false;

console.log(`\nPer-package lines coverage (floor ${packageLinesFloor}%):`);
for (const { directory, lines } of perPackage) {
  const below = lines < packageLinesFloor;
  console.log(
    `  ${below ? "FAIL" : "ok  "} ${directory.padEnd(32)} ${lines.toFixed(2)}%`,
  );
  if (below) {
    console.error(
      `Package ${directory} lines coverage ${lines.toFixed(2)}% is below the ${packageLinesFloor}% per-package floor.`,
    );
    failed = true;
  }
}

console.log("");
const counts = tally(coverage);
for (const key of ["statements", "branches", "functions", "lines"]) {
  const [covered, total] = counts[key];
  const value = percentage(counts[key]);
  const minimum = thresholds[key];
  console.log(
    `${key.padEnd(10)} ${value.toFixed(2)}% (${covered}/${total}), minimum ${minimum}%`,
  );
  failed ||= value < minimum;
}

if (failed) {
  console.error("TypeScript coverage thresholds were not met.");
  process.exit(1);
}

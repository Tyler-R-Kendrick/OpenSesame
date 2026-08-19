import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(root, "coverage", "typescript");
const thresholds = {
  branches: Number(process.env.TS_COVERAGE_BRANCHES ?? 80),
  functions: Number(process.env.TS_COVERAGE_FUNCTIONS ?? 80),
  lines: Number(process.env.TS_COVERAGE_LINES ?? 80),
  statements: Number(process.env.TS_COVERAGE_STATEMENTS ?? 80),
};

rmSync(outputRoot, { recursive: true, force: true });

const packages = ["apps", "packages"]
  .flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, group, entry.name)),
  )
  .filter((directory) => {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      return manifest.scripts?.test?.includes("vitest run") === true;
    } catch {
      return false;
    }
  })
  .sort();

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

const coverage = {};
for (const directory of packages) {
  const name = relative(root, directory).replaceAll("/", "-");
  const report = join(outputRoot, name, "coverage-final.json");
  Object.assign(coverage, JSON.parse(readFileSync(report, "utf8")));
}

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

let failed = false;
for (const key of ["statements", "branches", "functions", "lines"]) {
  const [covered, total] = counts[key];
  const percentage = total === 0 ? 100 : (covered / total) * 100;
  const minimum = thresholds[key];
  console.log(
    `${key.padEnd(10)} ${percentage.toFixed(2)}% (${covered}/${total}), minimum ${minimum}%`,
  );
  failed ||= percentage < minimum;
}

if (failed) {
  console.error("TypeScript coverage thresholds were not met.");
  process.exit(1);
}

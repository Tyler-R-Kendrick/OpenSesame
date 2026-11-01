// Trunk compiles the affected dependency graph. Test selection and execution
// remain in ci-affected-tests.mjs for environment qualification.
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fallbackPlan,
  loadCrateNodes,
  loadPackageNodes,
  planCrates,
  planPackages,
  repoRootFromHere,
} from "./ci-affected-graph.mjs";

const PACKAGE_INPUTS = new Set([".npmrc", ".pnpmfile.cjs"]);

function normalizedPaths(paths) {
  return paths.map((path) => path.replaceAll("\\", "/").replace(/^\.\//, ""));
}

function isDocument(path) {
  return (
    path.endsWith(".md") || path === "LICENSE" || path.endsWith("/LICENSE")
  );
}

/** Shared inputs and a removed package manifest must not silently select none. */
export function planBuildPackages(paths, nodes) {
  const normalized = normalizedPaths(paths);
  const sharedInput = normalized.some((path) => {
    if (isDocument(path)) return false;
    if (PACKAGE_INPUTS.has(path)) return true;
    if (path.startsWith("patches/") || path.startsWith("spec/")) return true;
    if (!path.endsWith("/package.json")) return false;
    return !nodes.some((node) => path === `${node.dir}/package.json`);
  });
  return sharedInput
    ? fallbackPlan("packages")
    : planPackages(normalized, nodes);
}

/** Cargo compiles prerequisites itself; the graph selects all reverse dependents. */
export function planBuildCrates(paths, nodes) {
  // Linter configuration affects local linting, not compilation.
  const normalized = normalizedPaths(paths).filter(
    (path) => !["clippy.toml", "rustfmt.toml", "deny.toml"].includes(path),
  );
  return planCrates(normalized, nodes);
}

export function readBuildPlan(root, kind, base, head) {
  try {
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) {
      throw new Error("BASE_SHA and HEAD_SHA must be commit shas");
    }
    // --no-renames includes both sides of a move. NUL separation preserves
    // filenames with whitespace without inventing additional changed paths.
    const diff = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`],
      { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    const paths = diff.split("\0").filter(Boolean);
    return kind === "cargo"
      ? planBuildCrates(paths, loadCrateNodes(root))
      : planBuildPackages(paths, loadPackageNodes(root));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `affected builds: ${message}; building the whole ${kind} graph`,
    );
    return fallbackPlan(kind);
  }
}

export function buildCommand(kind, plan, options = {}) {
  if (plan.scope === "none") return undefined;
  if (plan.scope === "packages" && plan.packages.length === 0) {
    throw new Error("affected build scope is packages but the list is empty");
  }
  const turboRef = text(options.turboComparisonRef);
  const comparisonFilter =
    turboRef.length > 0 ? `--filter=...[${turboRef}]` : undefined;
  const packageFilter = (name) =>
    turboRef.length > 0
      ? `--filter=${name}...[${turboRef}]`
      : `--filter=${name}`;
  if (kind === "cargo") {
    const args = ["build", "--locked"];
    if (plan.scope === "all") args.push("--workspace");
    else for (const name of plan.packages) args.push("-p", name);
    return { command: "cargo", args };
  }
  return {
    command: "npm",
    args: [
      "exec",
      "--",
      "turbo",
      "run",
      "build",
      "--concurrency=4",
      ...(plan.scope === "all"
        ? comparisonFilter
          ? [comparisonFilter]
          : []
        : plan.packages.map((name) => packageFilter(name))),
    ],
  };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function emit(plan) {
  const lines = [
    `scope=${plan.scope}`,
    `packages=${plan.packages.join(" ")}`,
    `selected=${plan.scope !== "none"}`,
    `bitwarden=${plan.bitwarden}`,
  ];
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, {
      flag: "a",
    });
  }
  for (const line of lines) console.log(line);
}

function main() {
  const command = process.argv[2] ?? "plan-ts";
  if (!["plan-ts", "plan-cargo", "run-ts", "run-cargo"].includes(command)) {
    console.error(
      "usage: ci-affected-builds.mjs plan-ts|plan-cargo|run-ts|run-cargo",
    );
    process.exit(2);
  }
  const kind = command.endsWith("cargo") ? "cargo" : "packages";
  const root = repoRootFromHere();
  const plan = readBuildPlan(
    root,
    kind,
    process.env.BASE_SHA ?? "",
    process.env.HEAD_SHA ?? "",
  );
  if (command.startsWith("plan-")) return emit(plan);
  const build = buildCommand(kind, plan, {
    turboComparisonRef: process.env.TURBO_COMPARISON_REF,
  });
  if (!build) {
    console.log(`no affected ${kind} build`);
    return;
  }
  const result = spawnSync(build.command, build.args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const invoked =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();

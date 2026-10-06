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
import { isDocPath } from "./ci-gates.mjs";
import { planUnitTests } from "./ci-scoped-tests.mjs";

export {
  loadCrateNodes,
  loadPackageNodes,
  planCrates,
  planPackages,
  repoRootFromHere,
} from "./ci-affected-graph.mjs";

function changedPaths(root) {
  const base = process.env.BASE_SHA ?? "";
  const head = process.env.HEAD_SHA ?? "";
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error("BASE_SHA and HEAD_SHA must be commit shas");
  }
  const diff = execFileSync(
    "git",
    ["diff", "--name-only", `${base}...${head}`],
    { encoding: "utf8", cwd: root },
  );
  return diff.split("\n").filter(Boolean);
}

function readPlan(kind) {
  const root = repoRootFromHere();
  try {
    const paths = changedPaths(root);
    if (kind === "cargo") return planCrates(paths, loadCrateNodes(root));
    return planPackages(paths, loadPackageNodes(root));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`affected tests: ${message}; testing everything`);
    return fallbackPlan(kind);
  }
}

function emit(plan) {
  const lines = [
    `scope=${plan.scope}`,
    `packages=${plan.packages.join(" ")}`,
    `verify_experience=${plan.verifyExperience ? "true" : "false"}`,
    `verify_packages=${plan.verifyPackages.join(",")}`,
    `lint_artifacts=${plan.lintArtifacts ? "true" : "false"}`,
    `bitwarden=${plan.bitwarden ? "true" : "false"}`,
  ];
  const output = process.env.GITHUB_OUTPUT;
  if (output) writeFileSync(output, `${lines.join("\n")}\n`, { flag: "a" });
  for (const line of lines) console.log(line);
}

function runListed(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runTs(plan) {
  if (plan.scope === "none") {
    console.log("no workspace package changed");
    return;
  }
  if (plan.scope === "all") {
    runListed("pnpm", ["typecheck"]);
    runListed("pnpm", ["test"]);
    return;
  }
  if (plan.packages.length === 0) {
    console.error("affected scope was packages but the list was empty");
    process.exit(1);
  }
  const filters = plan.packages.map((name) => `--filter=${name}`);
  runListed("pnpm", [
    "exec",
    "turbo",
    "run",
    "typecheck",
    "--concurrency=4",
    ...filters,
  ]);
  runUnitTests(plan);
}

/** Every changed path, deleted ones included, or undefined when unreadable. */
function allChangedPaths(root) {
  try {
    return changedPaths(root);
  } catch {
    return undefined;
  }
}

function runUnitTests(plan) {
  const root = repoRootFromHere();
  const paths = allChangedPaths(root);
  const plans =
    paths === undefined
      ? undefined
      : planUnitTests({
          root,
          nodes: loadPackageNodes(root),
          packages: plan.packages,
          paths,
          isDoc: isDocPath,
        });
  const whole = (plans ?? [])
    .filter((entry) => entry.mode === "full")
    .map((entry) => entry.name);
  if (plans === undefined) whole.push(...plan.packages);
  for (const entry of plans ?? []) {
    console.error(
      `unit tests: ${entry.name} ${entry.mode}${entry.why ? ` (${entry.why})` : ""}`,
    );
  }
  if (whole.length > 0) {
    runListed("pnpm", [
      "exec",
      "turbo",
      "run",
      "test",
      "--concurrency=4",
      ...whole.map((name) => `--filter=${name}`),
    ]);
  }
  for (const entry of plans ?? []) {
    if (entry.mode === "scoped") runScoped(root, entry);
  }
}

function runScoped(root, entry) {
  const vitest = ["--filter", entry.name, "exec", "vitest"];
  if (entry.related.length > 0) {
    runListed("pnpm", [
      ...vitest,
      "related",
      ...entry.related.map((path) => resolve(root, path)),
      "--run",
      "--passWithNoTests",
    ]);
  }
  const named = [...new Set([...entry.structural, ...entry.hubTests])];
  if (entry.hubs.length > 0) {
    console.error(
      `unit tests: ${entry.name} follows ${entry.hubs.join(", ")} ${entry.hubTests.length} tests deep, not the whole suite`,
    );
  }
  if (named.length > 0) {
    runListed("pnpm", [...vitest, "run", ...named, "--passWithNoTests"]);
  }
  if (entry.extra !== undefined && entry.extraRuns) {
    runListed("pnpm", [
      "--filter",
      entry.name,
      "exec",
      "sh",
      "-c",
      entry.extra,
    ]);
  }
}

function runCargo(plan) {
  if (plan.scope === "none") {
    console.log("no crate changed");
    return;
  }
  if (plan.scope === "all") {
    runListed("cargo", ["test", "--workspace", "--all-targets"]);
    return;
  }
  if (plan.packages.length === 0) {
    console.error("affected scope was packages but the list was empty");
    process.exit(1);
  }
  const args = ["test", "--all-targets"];
  for (const name of plan.packages) args.push("-p", name);
  runListed("cargo", args);
}

function main() {
  const command = process.argv[2] ?? "plan";
  if (command === "plan") {
    emit(readPlan("packages"));
    return;
  }
  if (command === "cargo") {
    emit(readPlan("cargo"));
    return;
  }
  if (command === "run-ts") {
    runTs(readPlan("packages"));
    return;
  }
  if (command === "run-cargo") {
    runCargo(readPlan("cargo"));
    return;
  }
  console.error("usage: ci-affected-tests.mjs plan|cargo|run-ts|run-cargo");
  process.exit(2);
}

const invoked =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();

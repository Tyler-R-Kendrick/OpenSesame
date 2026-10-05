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

function runListed(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const PAGES = "@opensesame/pages";

const filters = (list) => list.map((name) => `--filter=${name}`);
const turbo = (tasks, extra) => [
  "pnpm",
  ["exec", "turbo", "run", ...tasks, "--concurrency=4", ...extra],
];
const everything = (plan) => plan.scope === "all";

/** Typecheck and test the whole affected set in one go (a local run). */
function allLeg(plan) {
  if (everything(plan))
    return [
      ["pnpm", ["typecheck"]],
      ["pnpm", ["test"]],
    ];
  return [turbo(["typecheck", "test"], filters(plan.packages))];
}

function typecheckLeg(plan) {
  if (everything(plan)) return [["pnpm", ["typecheck"]]];
  return [turbo(["typecheck"], filters(plan.packages))];
}

/** Every affected package's tests but Pages', which has its own shards. */
function testsLeg(plan) {
  if (everything(plan)) return [turbo(["test"], [`--filter=!${PAGES}`])];
  const names = plan.packages.filter((name) => name !== PAGES);
  return names.length === 0 ? [] : [turbo(["test"], filters(names))];
}

/** The `at`-th of `of` shards of Pages' own suite. */
function pagesLeg(plan, at, of) {
  if (!everything(plan) && !plan.packages.includes(PAGES)) return [];
  const commands = [
    // What Pages' tests import is built first, as `turbo run test` would.
    ["pnpm", ["exec", "turbo", "run", "build", `--filter=${PAGES}^...`]],
    [
      "pnpm",
      ["--filter", PAGES, "exec", "vitest", "run", "--maxWorkers=4"].concat(
        `--shard=${at}/${of}`,
      ),
    ],
  ];
  // The relay's `node --test` suites ride with the first shard.
  if (at === "1") {
    const relay = ["exec", "node", "--test", "server/test/*.test.mjs"];
    commands.push(["pnpm", ["--filter", PAGES, ...relay]]);
  }
  return commands;
}

/**
 * The commands one leg of the TypeScript job runs. The job is a matrix of legs
 * so that no leg is the whole job: `typecheck`, `tests` (every affected package
 * but Pages), `pages:i/n` (the i-th of n shards of Pages' own suite, by far the
 * largest) and `experience`. `all` is everything in one go, for a local run.
 * Pure, so the plan for each leg is testable without running anything.
 */
export function legCommands(plan, leg = "all") {
  if (plan.scope === "none") return [];
  if (leg === "all") return allLeg(plan);
  if (leg === "typecheck") return typecheckLeg(plan);
  if (leg === "tests") return testsLeg(plan);
  if (leg === "experience") {
    return plan.verifyExperience ? [["pnpm", ["verify:experience"]]] : [];
  }
  const shard = /^pages:(\d+)\/(\d+)$/.exec(leg);
  if (shard) return pagesLeg(plan, shard[1], shard[2]);
  throw new Error(`unknown TypeScript leg: ${leg}`);
}

function runTs(plan, leg) {
  if (plan.scope === "none") {
    console.log("no workspace package changed");
    return;
  }
  if (plan.scope !== "all" && plan.packages.length === 0) {
    console.error("affected scope was packages but the list was empty");
    process.exit(1);
  }
  const commands = legCommands(plan, leg);
  if (commands.length === 0) console.log(`nothing for the ${leg} leg`);
  for (const [command, args] of commands) runListed(command, args);
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
    runTs(readPlan("packages"), process.env.TS_LEG ?? "all");
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

#!/usr/bin/env node
/**
 * pnpm test:authority-fabric — the general-authority verification gate.
 *
 * Reads the tree, resolves every scenario in the registry against what is
 * actually wired, runs the tests that exist, and writes the report under
 * docs/evidence/general-authority/. A scenario the harness cannot settle is
 * reported blocked and fails the gate; nothing here can produce a pass without
 * a named test having run.
 *
 * Flags:
 *   --report   write the report and exit 0 (for inspection, not for merging)
 *   --no-run   resolve statically without executing any test
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  capabilityIds,
  crateFacts,
  enumerateCargoTests,
  fileFacts,
  ledgerCandidates,
  ledgerInventory,
  moduleFacts,
  packageFacts,
  workspaceMembers,
} from "./lib/authority-fabric-facts.mjs";
import {
  enumerateScenarioCargoTests,
  readCargoResult,
  runCargoBatches,
} from "./lib/authority-fabric-cargo-run.mjs";
import { markdown, printSummary } from "./lib/authority-fabric-render.mjs";
import {
  BLOCKED_REASONS,
  assembleReport,
  exitCodeFor,
  resolveScenario,
  scenarios,
} from "./lib/authority-fabric.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(root, "docs", "evidence", "general-authority");
const reportOnly = process.argv.includes("--report");
const noRun = process.argv.includes("--no-run");

const treeBefore = gitStatusDigest();
const facts = collectFacts();
const resolutions = scenarios.map((scenario) => ({
  scenario,
  resolution: resolveScenario(scenario, facts),
}));

const cargoResults = runCargoBatches(resolutions, { root, noRun });
const vitestRuns = new Map();
const entries = resolutions.map(({ scenario, resolution }) =>
  resolution.status === "runnable"
    ? settle(scenario, resolution)
    : record(scenario, resolution),
);

const treeAfter = gitStatusDigest();
const report = assembleReport(
  {
    generatedAt: new Date().toISOString(),
    head: gitHead(),
    treeDirty: treeBefore !== "",
    // Several swarms are writing while this runs. When the tree moves mid-run,
    // scenarios were resolved against different states and cannot be compared
    // with each other, so the report says so instead of implying one snapshot.
    treeChangedDuringRun: treeBefore !== treeAfter,
    executed: !noRun,
    command: "pnpm test:authority-fabric",
    cargoExecution:
      "one `cargo test -p <crate> --lib -- --format terse` per crate; each scenario reads its own test's line",
  },
  entries,
);

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(
  join(evidenceDir, "authority-fabric-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
writeFileSync(
  join(evidenceDir, "authority-fabric-report.md"),
  markdown(report),
);
printSummary(report);

process.exit(reportOnly ? 0 : exitCodeFor(report));

function collectFacts() {
  const members = workspaceMembers(root);
  const cargoTargets = scenarios
    .filter((scenario) => scenario.target?.kind === "cargo")
    .map((scenario) => scenario.target);
  const crateNames = [...new Set(cargoTargets.map((target) => target.crate))];
  const crates = crateFacts(root, crateNames, members);
  const modules = moduleFacts(root, crates, cargoTargets);

  const { tests, testErrors } = enumerateScenarioCargoTests({
    root,
    noRun,
    cargoTargets,
    modules,
  });

  const packages = packageFacts(root);
  const paths = new Set();
  for (const scenario of scenarios) {
    const target = scenario.target;
    if (target === undefined) continue;
    if (target.kind === "vitest") {
      const pkg = packages[target.pkg];
      if (pkg !== undefined) paths.add(`${pkg.dir}/${target.file}`);
    }
    // Every path a scenario names is authored in the checked-in registry, so a
    // key being present is the fact worth branching on.
    for (const key of ["model", "harness", "canonical", "inventory"]) {
      const path = target[key];
      if (path !== undefined) paths.add(path);
    }
  }

  const ledgerTarget = scenarios.find(
    (scenario) => scenario.target?.kind === "ledger-inventory",
  )?.target;

  return {
    crates,
    modules,
    tests,
    testErrors,
    deferTests: !noRun,
    packages,
    files: fileFacts(root, [...paths]),
    capabilityIds: capabilityIds(root),
    ledgerInventory:
      ledgerTarget === undefined
        ? null
        : ledgerInventory(root, ledgerTarget.inventory),
    ledgerCandidates:
      ledgerTarget === undefined
        ? null
        : ledgerCandidates(root, ledgerTarget.directory),
    env: process.env,
  };
}

function record(scenario, resolution) {
  return {
    id: scenario.id,
    workItem: scenario.workItem,
    area: scenario.area,
    tier: scenario.tier,
    invariant: scenario.invariant,
    title: scenario.title,
    status: resolution.status,
    reason: resolution.reason ?? null,
    detail: resolution.detail ?? null,
    reproduce: null,
  };
}

/**
 * Run each crate's tests once (lib or bin) and keep every test's own line.
 * See `authority-fabric-cargo-run.mjs`.
 */

/** Settle a resolved scenario and record the command that reproduces it alone. */
function settle(scenario, resolution) {
  const reproduce = resolution.command.join(" ");
  if (noRun) {
    return {
      ...record(scenario, {
        status: "blocked",
        reason: BLOCKED_REASONS.notExecuted,
        detail: "--no-run was passed, so this scenario was not executed",
      }),
      reproduce,
    };
  }
  const outcome =
    scenario.target.kind === "cargo"
      ? readCargoResult(scenario, cargoResults)
      : runVitest(resolution.command, scenario);
  return { ...record(scenario, outcome), reproduce };
}

/**
 * Vitest is run once per file and the named test looked up in the JSON report.
 * A file that ran but does not contain the name is blocked, not passed: the
 * contract is the named assertion, not the file's overall exit code.
 */
function runVitest(command, scenario) {
  const key = command.join(" ");
  if (!vitestRuns.has(key)) {
    vitestRuns.set(
      key,
      spawnSync(command[0], command.slice(1), {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }),
    );
  }
  const result = vitestRuns.get(key);
  const parsed = parseVitestJson(result.stdout);
  if (parsed === null) {
    return {
      status: "blocked",
      reason: BLOCKED_REASONS.harnessError,
      detail: tail(`${result.stdout}\n${result.stderr}`),
    };
  }
  const wanted = scenario.target.test ?? scenario.title;
  const assertion = parsed.assertions.find(
    (entry) => entry.title === wanted || entry.fullName?.endsWith(wanted),
  );
  if (assertion === undefined) {
    // A suite that failed to collect reports zero assertions, which must not be
    // read as "the test is missing" — the contract is unproven, not absent.
    const suiteFile =
      scenario.target.file ?? scenario.target.harness ?? "suite";
    if (parsed.suiteFailures.length > 0) {
      return {
        status: "blocked",
        reason: BLOCKED_REASONS.suiteFailed,
        detail: `${suiteFile} did not run: ${parsed.suiteFailures.join("; ")}`,
      };
    }
    return {
      status: "blocked",
      reason: BLOCKED_REASONS.noTest,
      detail: `${suiteFile} ran but contains no test named "${wanted}"`,
    };
  }
  if (assertion.status === "passed") {
    return { status: "pass", detail: `"${wanted}" ran and passed` };
  }
  return {
    status: "fail",
    reason: `vitest reported ${assertion.status}`,
    detail: tail((assertion.failureMessages ?? []).join("\n")),
  };
}

/**
 * pnpm prints its own failure lines after vitest's JSON, so the report is sliced
 * between the first brace and the last rather than read to end of stream.
 */
function parseVitestJson(stdout) {
  // Structured app logs may print JSON before vitest's report. Walk braces
  // backward from the final closing brace until an object with testResults
  // parses — the first `{` on the wire is often a log line, not the report.
  const end = stdout.lastIndexOf("}");
  if (end === -1) return null;
  for (
    let start = stdout.lastIndexOf("{", end);
    start !== -1;
    start = stdout.lastIndexOf("{", start - 1)
  ) {
    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      if (!Array.isArray(parsed.testResults)) continue;
      const files = parsed.testResults;
      return {
        assertions: files.flatMap((file) => file.assertionResults ?? []),
        suiteFailures: files
          .filter(
            (file) =>
              file.status === "failed" &&
              (file.assertionResults ?? []).length === 0,
          )
          .map((file) => file.message ?? "suite failed with no message"),
      };
    } catch {
      // Not a complete object at this brace; try an earlier one.
    }
  }
  return null;
}

function tail(text) {
  const lines = text.trim().split("\n");
  return lines.slice(-12).join("\n");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitHead() {
  return git(["rev-parse", "HEAD"]);
}

function gitStatusDigest() {
  return git(["status", "--porcelain"]) ?? "";
}

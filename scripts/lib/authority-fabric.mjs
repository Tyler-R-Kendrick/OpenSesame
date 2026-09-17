/**
 * Pure verdict logic for the authority-fabric gate (work item TEST-STACK).
 *
 * Nothing here touches the filesystem, the network, or a subprocess: the gate
 * entry point collects facts and hands them in, so every verdict is a function
 * of recorded facts and can be tested. The one rule this module exists to keep
 * is that an unresolvable scenario is `blocked`, never absent and never green.
 */

import {
  cargoBatchKey,
  cargoSuiteArgs,
} from "./authority-fabric-cargo-run.mjs";
import { STATUSES, TIERS, scenarios } from "./authority-fabric-scenarios.mjs";

export { STATUSES, TIERS, scenarios };

/** Why a scenario could not be settled. Each is a fact, not a judgement. */
export const BLOCKED_REASONS = Object.freeze({
  crateNotInWorkspace: "crate-not-in-workspace",
  crateLibMissing: "crate-lib-target-missing",
  moduleNotDeclared: "module-not-declared",
  enumerationFailed: "test-enumeration-failed",
  noTest: "no-test-asserts-contract",
  fileMissing: "test-file-missing",
  harnessMissing: "harness-missing",
  harnessError: "harness-error",
  buildFailed: "build-failed",
  suiteFailed: "suite-failed-to-run",
  notExecuted: "not-executed",
  vacuous: "vacuous-no-subject",
  secondLedger: "second-local-ledger-present",
  stackNotConfigured: "live-stack-not-configured",
});

const blocked = (reason, detail) => ({ status: "blocked", reason, detail });
const runnable = (command) => ({ status: "runnable", command });

/**
 * Decide a scenario from static facts. Returns either a terminal verdict or
 * `runnable` with the exact command that would settle it. Callers must treat a
 * missing verdict as an error, not as a pass.
 */
export function resolveScenario(scenario, facts) {
  if (scenario.tier === "unsupported") {
    return {
      status: "unsupported",
      reason: scenario.unsupported.reason,
      detail: scenario.unsupported.wouldRequire,
    };
  }
  const target = scenario.target;
  switch (target.kind) {
    case "cargo":
      return resolveCargo(target, facts);
    case "vitest":
      return resolveVitest(target, facts);
    case "registry-sweep":
      return resolveRegistrySweep(target, facts);
    case "ledger-inventory":
      return resolveLedgerInventory(target, facts);
    case "fga-additivity":
      return resolveFgaAdditivity(target, facts);
    case "live-stack":
      return resolveLiveStack(target, facts);
    default:
      throw new Error(`unknown target kind: ${String(target.kind)}`);
  }
}

function resolveCargo(target, facts) {
  const crate = facts.crates[target.crate];
  if (crate === undefined || crate.inWorkspace !== true) {
    return blocked(
      BLOCKED_REASONS.crateNotInWorkspace,
      `${target.crate} is not a member of the Cargo workspace, so nothing in it is compiled or tested`,
    );
  }
  const suiteMissing = cargoSuiteMissing(crate, target);
  if (suiteMissing !== null) {
    return blocked(BLOCKED_REASONS.crateLibMissing, suiteMissing);
  }
  const declared = facts.modules[`${target.crate}:${target.module}`];
  if (declared !== true) {
    return blocked(
      BLOCKED_REASONS.moduleNotDeclared,
      `${target.module} is on disk but no mod declaration reaches it from ${target.crate}'s crate root`,
    );
  }
  const testKey = cargoBatchKey(target);
  const enumBlock = cargoEnumerationBlock(facts, testKey, target.test);
  if (enumBlock !== null) return enumBlock;
  return runnable([
    "cargo",
    "+1.88.0",
    "test",
    "-p",
    target.crate,
    ...cargoSuiteArgs(target),
    "--",
    "--exact",
    target.test,
  ]);
}

function cargoSuiteMissing(crate, target) {
  if (typeof target.bin === "string") {
    return crate.binExists === true
      ? null
      : `${target.crate} declares no bin target reachable for fabric scenarios`;
  }
  return crate.libExists === true
    ? null
    : `${target.crate} declares a lib target at ${crate.libPath ?? "src/lib.rs"} that does not exist`;
}

function cargoEnumerationBlock(facts, testKey, testName) {
  if (facts.deferTests === true) return null;
  const known = facts.tests[testKey];
  if (known === undefined || known === null) {
    return blocked(
      BLOCKED_REASONS.enumerationFailed,
      facts.testErrors?.[testKey] ?? `could not enumerate tests for ${testKey}`,
    );
  }
  if (!known.includes(testName)) {
    return blocked(
      BLOCKED_REASONS.noTest,
      `${testName} does not exist; the module compiles but nothing asserts this contract`,
    );
  }
  return null;
}

function resolveVitest(target, facts) {
  const pkg = facts.packages[target.pkg];
  if (pkg === undefined) {
    return blocked(
      BLOCKED_REASONS.harnessMissing,
      `${target.pkg} is not a workspace package`,
    );
  }
  const path = `${pkg.dir}/${target.file}`;
  if (facts.files[path] !== true) {
    return blocked(
      BLOCKED_REASONS.fileMissing,
      `${path} does not exist; no test asserts this contract`,
    );
  }
  return runnable([
    "pnpm",
    "--filter",
    target.pkg,
    "exec",
    "vitest",
    "run",
    "--reporter=json",
    target.file,
  ]);
}

/**
 * INV-GA-12 over the capability registry. The contract itself is already
 * enforced for every capability by the registry's own parity test, so this
 * scenario checks that authority capabilities exist to be swept and then defers
 * to that test rather than reimplementing it.
 *
 * Zero authority capabilities is blocked, not a pass: a sweep with no subject
 * proves nothing, and reading it as green is how a parity gate goes quiet.
 */
function resolveRegistrySweep(target, facts) {
  const ids = facts.capabilityIds;
  if (ids === null || ids === undefined) {
    return blocked(
      BLOCKED_REASONS.harnessMissing,
      "packages/capability-registry could not be read",
    );
  }
  const subjects = ids.filter((id) =>
    target.prefixes.some((prefix) => id.startsWith(prefix)),
  );
  if (subjects.length === 0) {
    return blocked(
      BLOCKED_REASONS.vacuous,
      `no capability id starts with ${target.prefixes.join(" or ")}; GA-C-01 has not landed, so this sweep has nothing to check`,
    );
  }
  return runnable([
    "pnpm",
    "--filter",
    target.pkg,
    "exec",
    "vitest",
    "run",
    "--reporter=json",
    target.sweep,
  ]);
}

/**
 * INV-GA-10: one local authority ledger in apps/pages, not two.
 *
 * A filename heuristic cannot settle this. `local-grant-store.ts` holds
 * application OIDC grants and `local-rbac.ts` holds Access roles — different
 * concerns that a name match would report as rival authority ledgers. The check
 * needs a checked-in inventory saying which local stores exist and why, which is
 * GA-P-01's to write; until it exists the scenario is blocked rather than
 * guessed either way.
 */
function resolveLedgerInventory(target, facts) {
  if (facts.files[target.canonical] !== true) {
    return blocked(
      BLOCKED_REASONS.fileMissing,
      `${target.canonical} is the ledger INV-GA-10 names and it is not present`,
    );
  }
  const inventory = facts.ledgerInventory;
  if (inventory === null || inventory === undefined) {
    return blocked(
      BLOCKED_REASONS.harnessMissing,
      `${target.inventory} does not exist; a filename sweep of ${target.directory} would report local-grant-store.ts (application OIDC grants) as a rival ledger, so this contract needs a declared inventory, not a heuristic`,
    );
  }
  const candidates = facts.ledgerCandidates;
  if (candidates === null || candidates === undefined) {
    return blocked(
      BLOCKED_REASONS.harnessMissing,
      `${target.directory} could not be scanned, so nothing was compared against ${target.inventory}`,
    );
  }
  if (candidates.length === 0) {
    return blocked(
      BLOCKED_REASONS.vacuous,
      `no module under ${target.directory} is in the authority-naming family, which cannot be right while ${target.canonical} is one — the scan found nothing to classify`,
    );
  }
  const classified = [
    ...inventory.declared,
    ...(inventory.notLedgers ?? []).map((entry) => entry.path),
  ];
  const unclassified = candidates.filter((file) => !classified.includes(file));
  if (unclassified.length > 0) {
    return blocked(
      BLOCKED_REASONS.secondLedger,
      `${unclassified.join(", ")} are in the authority-naming family but appear in neither "declared" nor "notLedgers" of ${target.inventory}; classify each one, with the reason, before this contract can hold`,
    );
  }
  return {
    status: "pass",
    detail: `all ${candidates.length} authority-named modules under ${target.directory} are classified in ${target.inventory}, with ${inventory.declared.length} declared the ledger`,
  };
}

function resolveFgaAdditivity(target, facts) {
  if (facts.files[target.model] !== true) {
    return blocked(
      BLOCKED_REASONS.harnessMissing,
      `${target.model} is missing`,
    );
  }
  if (facts.files[target.harness] !== true) {
    return blocked(
      BLOCKED_REASONS.harnessMissing,
      `${target.harness} does not exist; GA-F-03 owns it and INV-GA-03 is unprovable without it`,
    );
  }
  // Provider tier: live OpenFGA is required to settle INV-GA-03. Absence is
  // blocked (honest), never inferred green from the structural unit half.
  if ((facts.env?.OPENSESAME_OPENFGA_URL ?? "") === "") {
    return blocked(
      BLOCKED_REASONS.stackNotConfigured,
      "OPENSESAME_OPENFGA_URL is unset; GA-V-32 needs a live OpenFGA to replay baseline allows against the delta",
    );
  }
  return runnable([
    "pnpm",
    "--filter",
    "@opensesame/policy",
    "exec",
    "vitest",
    "run",
    "--reporter=json",
    target.harness.replace("packages/policy/", ""),
  ]);
}

function resolveLiveStack(target, facts) {
  const missing = target.requires.filter(
    (name) => (facts.env[name] ?? "") === "",
  );
  if (missing.length > 0) {
    return blocked(
      BLOCKED_REASONS.stackNotConfigured,
      `live tier needs ${missing.join(", ")}; a live scenario is never inferred from a unit run`,
    );
  }
  return runnable(["bash", target.script]);
}

/** Roll entries into the report body. Counts are derived, never asserted. */
export function assembleReport(meta, entries) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const byTier = Object.fromEntries(
    TIERS.map((tier) => [
      tier,
      Object.fromEntries(STATUSES.map((s) => [s, 0])),
    ]),
  );
  for (const entry of entries) {
    byStatus[entry.status] += 1;
    byTier[entry.tier][entry.status] += 1;
  }
  return {
    $schema: "./authority-fabric-report.schema.json",
    $comment:
      "Produced by pnpm test:authority-fabric. A scenario is green only when a named test in a wired module ran and passed. 'blocked' means the harness could not settle the contract and fails the gate.",
    programme: "general-authority",
    swarm: "VERIFICATION",
    workItems: [
      "TEST-STACK",
      "TEST-SCENARIOS",
      "TEST-RACES",
      "TEST-PARITY",
      "TEST-REPORT",
    ],
    ...meta,
    tierVocabulary: TIERS,
    statusVocabulary: STATUSES,
    summary: {
      total: entries.length,
      byStatus,
      byTier,
      gate: gateVerdict(byStatus),
    },
    scenarios: entries,
  };
}

function gateVerdict(byStatus) {
  if (byStatus.fail > 0) return "fail";
  if (byStatus.blocked > 0) return "blocked";
  return "pass";
}

/**
 * A `blocked` scenario fails the gate: the fabric is not proven, and a gate that
 * passes on "not implemented yet" is worse than no gate. `unsupported` is
 * declared with a reason and counted apart, so it cannot hide a regression.
 */
export function exitCodeFor(report) {
  return report.summary.gate === "pass" ? 0 : 1;
}

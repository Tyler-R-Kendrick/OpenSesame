#!/usr/bin/env node
/**
 * pnpm wallet:verify — orchestrate wallet BUILD gates (fail closed).
 *
 * Runs mainnet deny, domain tests, then package suite runners
 * (contracts/protocols/browser/security). Always writes
 * docs/evidence/wallet/last-run.json. A green exit requires every suite to
 * pass real tests — stubs never pass. Contract suite is in-memory simulation
 * Contracts/protocols mark local_execution_verified only after forge/Anvil harness success.
 */

function isPlainNumber(value) {
  return (
    Object(value) !== value &&
    Object.prototype.toString.call(value) === "[object Number]"
  );
}

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoMainnet } from "./lib/deny-mainnet.mjs";
import { discoverDomainTargets } from "./lib/discover.mjs";
import { EVIDENCE_REL, writeWalletEvidence } from "./lib/evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dryRun = process.argv.includes("--dry-run");

const mainnet = assertNoMainnet(
  process.argv.filter((a) => a !== "--dry-run").slice(2),
);
if (!mainnet.ok) {
  writeWalletEvidence(root, {
    invokedAs: "pnpm wallet:verify",
    mainnet: {
      ok: false,
      message: mainnet.message,
      denials: mainnet.denials,
    },
    results: [
      {
        suite: "mainnet-deny",
        status: "failed",
        exitCode: 2,
        reason: mainnet.message,
        command: null,
        durationMs: null,
      },
    ],
    ok: false,
    notes: ["Mainnet hard-deny aborted verify."],
  });
  console.error(mainnet.message);
  process.exit(2);
}

/** @type {import("./lib/evidence.mjs").SuiteResult[]} */
const results = [
  {
    suite: "mainnet-deny",
    status: "passed",
    exitCode: 0,
    reason: null,
    command: "assertNoMainnet()",
    durationMs: 0,
  },
];

const domainArgs = ["node", "scripts/wallet/test-domain.mjs"];
if (dryRun) domainArgs.push("--dry-run");

const domain = runNode(domainArgs);
results.push({
  suite: "domain",
  status: domain.exitCode === 0 ? "passed" : dryRun ? "blocked" : "failed",
  exitCode: domain.exitCode,
  reason:
    domain.exitCode === 0
      ? null
      : dryRun
        ? "dry-run: domain commands discovered but not executed (not a pass)"
        : "wallet:test:domain exited non-zero (missing packages and/or failing tests)",
  command: domainArgs.join(" "),
  durationMs: domain.durationMs,
});

/** Real package runners (simulation/unit). Not Anvil local_execution_verified. */
const suiteNames = ["contracts", "protocols", "browser", "security"];
for (const suite of suiteNames) {
  if (dryRun) {
    results.push({
      suite,
      status: "blocked",
      exitCode: 0,
      reason: `dry-run: suite '${suite}' not executed`,
      command: `node scripts/wallet/run-suite.mjs ${suite}`,
      durationMs: null,
    });
    continue;
  }
  const run = runNode(["node", "scripts/wallet/run-suite.mjs", suite]);
  results.push({
    suite,
    status: run.exitCode === 0 ? "passed" : "failed",
    exitCode: run.exitCode,
    reason:
      run.exitCode === 0 ? null : `suite '${suite}' exited ${run.exitCode}`,
    command: `node scripts/wallet/run-suite.mjs ${suite}`,
    durationMs: run.durationMs,
  });
}

const targets = discoverDomainTargets(root);
const ok = results.every((r) => r.status === "passed");

writeWalletEvidence(root, {
  invokedAs: dryRun ? "pnpm wallet:verify --dry-run" : "pnpm wallet:verify",
  mainnet: { ok: true, message: null, denials: [] },
  results,
  ok,
  notes: [
    dryRun
      ? "Dry-run: domain discovery + stub inventory only; ok is false until real suites pass."
      : ok
        ? "All wallet suites passed."
        : "Verify fail-closed: failing package suites are not success.",
    `Domain targets present: ${
      targets
        .filter((t) => t.present)
        .map((t) => t.id)
        .join(", ") || "(none)"
    }`,
    `Domain targets missing: ${
      targets
        .filter((t) => !t.present)
        .map((t) => t.id)
        .join(", ") || "(none)"
    }`,
    `Evidence: ${EVIDENCE_REL}`,
  ],
});

printSummary(results, ok);
process.exit(ok ? 0 : 1);

/**
 * @param {string[]} args full argv including node
 */
function runNode(args) {
  const started = Date.now();
  const r = spawnSync(args[0] ?? "node", args.slice(1), {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return {
    exitCode: isPlainNumber(r.status) ? r.status : 1,
    durationMs: Date.now() - started,
  };
}

/**
 * @param {import("./lib/evidence.mjs").SuiteResult[]} suiteResults
 * @param {boolean} allOk
 */
function printSummary(suiteResults, allOk) {
  console.error("");
  console.error("wallet:verify summary");
  for (const r of suiteResults) {
    const mark =
      r.status === "passed"
        ? "PASS"
        : r.status === "blocked"
          ? "BLOCKED"
          : "FAIL";
    console.error(`  [${mark}] ${r.suite}${r.reason ? ` — ${r.reason}` : ""}`);
  }
  console.error(
    allOk
      ? `wallet:verify — PASS. See ${EVIDENCE_REL}`
      : `wallet:verify — FAIL (ok=false). See ${EVIDENCE_REL}`,
  );
}

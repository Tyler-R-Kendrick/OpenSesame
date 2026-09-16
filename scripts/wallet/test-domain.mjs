#!/usr/bin/env node
/**
 * pnpm wallet:test:domain — run domain unit tests when packages exist.
 *
 * Discovers:
 *   - packages/os-domain/src/wallet/**
 *   - packages/wallet-budget
 *   - packages/wallet-policy
 *
 * Missing packages → blocked (exit 1). Never reports a green pass without a
 * real vitest/pnpm test exit 0.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoMainnet } from "./lib/deny-mainnet.mjs";
import { discoverDomainTargets } from "./lib/discover.mjs";
import {
  EVIDENCE_REL,
  runCommand,
  writeWalletEvidence,
} from "./lib/evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dryRun = process.argv.includes("--dry-run");

const mainnet = assertNoMainnet(
  process.argv.filter((a) => a !== "--dry-run").slice(2),
);
if (!mainnet.ok) {
  writeWalletEvidence(root, {
    invokedAs: "pnpm wallet:test:domain",
    mainnet: {
      ok: false,
      message: mainnet.message,
      denials: mainnet.denials,
    },
    results: [
      {
        suite: "domain",
        status: "failed",
        exitCode: 2,
        reason: mainnet.message,
        command: null,
        durationMs: null,
      },
    ],
    ok: false,
    notes: ["Mainnet hard-deny fired; domain tests were not started."],
  });
  console.error(mainnet.message);
  process.exit(2);
}

const targets = discoverDomainTargets(root);
/** @type {import("./lib/evidence.mjs").SuiteResult[]} */
const results = [];

for (const target of targets) {
  if (!target.present || target.testCommand === null) {
    results.push({
      suite: `domain:${target.id}`,
      status: "blocked",
      exitCode: 1,
      reason: target.missingReason,
      command: null,
      durationMs: null,
      details: {
        packageDir: target.packageDir,
        packageName: target.packageName,
      },
    });
    console.error(
      `wallet:domain blocked — ${target.id}: ${target.missingReason}`,
    );
    continue;
  }

  const command = target.testCommand;
  const commandStr = command.join(" ");
  console.error(
    `wallet:domain ${dryRun ? "would run" : "run"} — ${commandStr}`,
  );

  if (dryRun) {
    results.push({
      suite: `domain:${target.id}`,
      status: "blocked",
      exitCode: 1,
      reason: "dry-run only; command was not executed (not a pass)",
      command: commandStr,
      durationMs: null,
      details: {
        packageDir: target.packageDir,
        matchedPaths: target.matchedPaths.slice(0, 20),
      },
    });
    continue;
  }

  const run = runCommand(root, command);
  const passed = run.exitCode === 0;
  results.push({
    suite: `domain:${target.id}`,
    status: passed ? "passed" : "failed",
    exitCode: run.exitCode,
    reason: passed ? null : `test command exited ${run.exitCode}`,
    command: commandStr,
    durationMs: run.durationMs,
    details: {
      packageDir: target.packageDir,
      matchedPaths: target.matchedPaths.slice(0, 20),
      stdoutTail: redactSecrets(run.stdoutTail),
      stderrTail: redactSecrets(run.stderrTail),
    },
  });
  if (!passed) {
    if (run.stderrTail) console.error(run.stderrTail);
    if (run.stdoutTail) console.error(run.stdoutTail);
  }
}

const anyMissing = results.some((r) => r.status === "blocked");
const anyFailed = results.some((r) => r.status === "failed");
const allPassed =
  results.length > 0 && results.every((r) => r.status === "passed");
const ok = allPassed && !anyMissing && !anyFailed;

writeWalletEvidence(root, {
  invokedAs: dryRun
    ? "pnpm wallet:test:domain --dry-run"
    : "pnpm wallet:test:domain",
  mainnet: { ok: true, message: null, denials: [] },
  results,
  ok,
  notes: [
    dryRun
      ? "Dry-run: discovery only; no tests executed; ok is false."
      : ok
        ? "All discovered domain targets ran and exited 0."
        : "Domain gate fail-closed: missing packages and/or failing tests are not success.",
    `Evidence: ${EVIDENCE_REL}`,
  ],
});

if (!ok) {
  console.error(`wallet:test:domain — FAIL (ok=false). See ${EVIDENCE_REL}`);
  process.exit(1);
}

console.error(`wallet:test:domain — PASS. See ${EVIDENCE_REL}`);
process.exit(0);

/** @param {string} text */
function redactSecrets(text) {
  return text
    .replace(/\b(sk|pk|api)[_-][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/\b[A-Fa-f0-9]{64}\b/g, "[redacted-hex]");
}

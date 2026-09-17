#!/usr/bin/env node
/**
 * Real wallet suite runners (fail closed on missing packages / failing tests).
 * Usage: node scripts/wallet/run-suite.mjs <contracts|protocols|browser|security>
 *
 * Honesty:
 * - contracts: runs @opensesame/wallet-evm unit tests (simulation). Live Anvil
 *   deployment remains blocked until forge/anvil is available.
 * - protocols: Anvil Exact EIP-3009 settle + x402/consent unit fixtures.
 * - browser: runs Pages WalletSection + spending-ledger tests.
 * - security: reuses domain discovery (budget + policy + os-domain wallet).
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoMainnet } from "./lib/deny-mainnet.mjs";
import { discoverDomainTargets } from "./lib/discover.mjs";
import { EVIDENCE_REL, writeWalletEvidence } from "./lib/evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const suite = process.argv[2];

/**
 * @typedef {{
 *   label: string,
 *   notes: string[],
 *   commands: Array<[string, string[]]>,
 * }} SuiteConfig
 */

/** @type {Record<string, SuiteConfig>} */
const SUITES = {
  contracts: {
    label: "contracts",
    notes: [
      "Delegates to scripts/wallet/contracts-harness.mjs (forge + simulation).",
      "On success: local_execution_verified for period/amount shared-parent pin.",
    ],
    commands: [["node", ["scripts/wallet/contracts-harness.mjs"]]],
  },
  protocols: {
    label: "protocols",
    notes: [
      "Delegates to scripts/wallet/protocols-harness.mjs (Anvil Exact EIP-3009).",
      "On success: local_execution_verified for WAL-E11/E13/E14 + x402-exact adapter.",
    ],
    commands: [["node", ["scripts/wallet/protocols-harness.mjs"]]],
  },
  browser: {
    label: "browser",
    notes: [
      "Delegates to scripts/wallet/browser-harness.mjs (Vitest + Playwright QAB).",
    ],
    commands: [["node", ["scripts/wallet/browser-harness.mjs"]]],
  },
  security: {
    label: "security",
    notes: [
      "Conservation identity, policy intersection, and domain wallet parsers.",
      "Commands come from discoverDomainTargets (same as wallet:test:domain).",
    ],
    commands: [],
  },
};

if (suite === undefined || !(suite in SUITES)) {
  console.error(
    `wallet:run-suite — usage: node scripts/wallet/run-suite.mjs <${Object.keys(SUITES).join("|")}>`,
  );
  process.exit(2);
}

const mainnet = assertNoMainnet(process.argv.slice(3));
if (!mainnet.ok) {
  writeWalletEvidence(root, {
    invokedAs: `pnpm wallet:test:${suite}`,
    mainnet: {
      ok: false,
      message: mainnet.message,
      denials: mainnet.denials,
    },
    results: [
      {
        suite,
        status: "failed",
        exitCode: 2,
        reason: mainnet.message,
        command: null,
        durationMs: null,
      },
    ],
    ok: false,
    notes: ["Mainnet hard-deny fired before the suite ran."],
  });
  console.error(mainnet.message);
  process.exit(2);
}

const config = SUITES[suite];
/** @type {Array<[string, string[]]>} */
let commands = config.commands;
if (suite === "security") {
  const targets = discoverDomainTargets(root);
  commands = [];
  for (const target of targets) {
    if (!target.present || target.testCommand === null) {
      writeWalletEvidence(root, {
        invokedAs: `pnpm wallet:test:${suite}`,
        mainnet: { ok: true, message: null, denials: [] },
        results: [
          {
            suite,
            status: "failed",
            exitCode: 1,
            reason: target.missingReason ?? `${target.id} missing`,
            command: null,
            durationMs: null,
          },
        ],
        ok: false,
        notes: ["Security suite requires all domain targets present."],
      });
      console.error(`wallet:test:${suite} — missing ${target.id}`);
      process.exit(1);
    }
    const [cmd, ...args] = target.testCommand;
    if (cmd === undefined) continue;
    commands.push([cmd, args]);
  }
  commands.push([
    "pnpm",
    ["exec", "vitest", "run", "scripts/wallet/lib/deny-mainnet.test.mjs"],
  ]);
  commands.push(["pnpm", ["--filter", "@opensesame/wallet-evm", "test"]]);
  commands.push(["pnpm", ["--filter", "@opensesame/wallet-consent", "test"]]);
  commands.push(["pnpm", ["--filter", "@opensesame/wallet-x402", "test"]]);
}

const started = Date.now();
const commandResults = [];
let ok = true;

for (const [cmd, args] of commands) {
  const command = [cmd, ...args].join(" ");
  console.error(`wallet:test:${suite} — ${command}`);
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CHAIN_ID: process.env.CHAIN_ID ?? "31337" },
  });
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) ok = false;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  commandResults.push({
    suite,
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    reason: exitCode === 0 ? null : `${command} exited ${exitCode}`,
    command,
    durationMs: null,
  });
}

writeWalletEvidence(root, {
  invokedAs: `pnpm wallet:test:${suite}`,
  mainnet: { ok: true, message: null, denials: [] },
  results: commandResults,
  ok,
  notes: [
    ...config.notes,
    `Evidence: ${EVIDENCE_REL}`,
    `durationMs≈${Date.now() - started}`,
  ],
});

if (!ok) {
  console.error(`wallet:test:${suite} — FAIL. See ${EVIDENCE_REL}`);
  process.exit(1);
}
console.error(`wallet:test:${suite} — PASS. See ${EVIDENCE_REL}`);

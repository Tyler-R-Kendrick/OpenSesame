#!/usr/bin/env node
/**
 * pnpm wallet:evidence — refresh docs/evidence/wallet/last-run.json from
 * discovery + mainnet check without claiming suite passes.
 *
 * Always exits non-zero while any required suite is missing or stubbed.
 * Use after other wallet:* commands, or alone for an inventory snapshot.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoMainnet } from "./lib/deny-mainnet.mjs";
import { discoverDomainTargets } from "./lib/discover.mjs";
import { EVIDENCE_REL, writeWalletEvidence } from "./lib/evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const mainnet = assertNoMainnet(process.argv.slice(2));
if (!mainnet.ok) {
  writeWalletEvidence(root, {
    invokedAs: "pnpm wallet:evidence",
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
    notes: ["Mainnet hard-deny; evidence written with ok=false."],
  });
  console.error(mainnet.message);
  console.error(`wallet: wrote ${EVIDENCE_REL}`);
  process.exit(2);
}

const targets = discoverDomainTargets(root);
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

for (const t of targets) {
  results.push({
    suite: `domain:${t.id}`,
    status: "blocked",
    exitCode: 1,
    reason: t.present
      ? "inventory only — run pnpm wallet:test:domain to execute tests (evidence alone is not a pass)"
      : t.missingReason,
    command: t.testCommand ? t.testCommand.join(" ") : null,
    durationMs: null,
    details: {
      present: t.present,
      packageDir: t.packageDir,
      matchedPaths: t.matchedPaths.slice(0, 20),
    },
  });
}

for (const suite of ["contracts", "protocols", "browser", "security"]) {
  results.push({
    suite,
    status: "blocked",
    exitCode: 1,
    reason: `suite '${suite}' not implemented yet`,
    command: `node scripts/wallet/stub.mjs ${suite}`,
    durationMs: null,
  });
}

writeWalletEvidence(root, {
  invokedAs: "pnpm wallet:evidence",
  mainnet: { ok: true, message: null, denials: [] },
  results,
  ok: false,
  notes: [
    "wallet:evidence never marks ok=true — it only snapshots inventory.",
    "Run pnpm wallet:verify after real suites exist to earn a pass.",
    `Evidence: ${EVIDENCE_REL}`,
  ],
});

console.error(
  `wallet:evidence — wrote ${EVIDENCE_REL} (ok=false, inventory only)`,
);
for (const t of targets) {
  console.error(
    `  domain:${t.id} — ${t.present ? "present" : "missing"}${t.missingReason ? ` (${t.missingReason})` : ""}`,
  );
}
process.exit(1);

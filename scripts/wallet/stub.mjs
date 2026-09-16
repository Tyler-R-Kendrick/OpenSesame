#!/usr/bin/env node
/**
 * Fail-closed stub for wallet suites that do not exist yet.
 * Usage: node scripts/wallet/stub.mjs <contracts|protocols|browser|security>
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoMainnet } from "./lib/deny-mainnet.mjs";
import { EVIDENCE_REL, writeWalletEvidence } from "./lib/evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const suite = process.argv[2];

const KNOWN = new Set(["contracts", "protocols", "browser", "security"]);

if (suite === undefined || !KNOWN.has(suite)) {
  console.error(
    `wallet:stub — usage: node scripts/wallet/stub.mjs <${[...KNOWN].join("|")}>`,
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
    notes: ["Mainnet hard-deny fired before the suite stub ran."],
  });
  console.error(mainnet.message);
  process.exit(2);
}

const reason = `wallet:test:${suite} — suite not implemented yet (fail closed). No ${suite} harness exists under scripts/wallet/; do not treat this as a pass.`;

writeWalletEvidence(root, {
  invokedAs: `pnpm wallet:test:${suite}`,
  mainnet: { ok: true, message: null, denials: [] },
  results: [
    {
      suite,
      status: "blocked",
      exitCode: 1,
      reason,
      command: null,
      durationMs: null,
    },
  ],
  ok: false,
  notes: [
    "Stubs fail closed until a real suite lands. Absence of tests is not success.",
    `Evidence: ${EVIDENCE_REL}`,
  ],
});

console.error(reason);
console.error(`wallet: wrote ${EVIDENCE_REL} (ok=false)`);
process.exit(1);

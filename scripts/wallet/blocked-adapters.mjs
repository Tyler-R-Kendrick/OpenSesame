#!/usr/bin/env node
/**
 * Record honest blocked evidence for prepaid channel adapters.
 * AP2/UCP ES256 is fixture-local via @opensesame/wallet-mandates; this script
 * must not overwrite WAL-B10–B12 back to blocked.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EVIDENCE_REL, writeWalletEvidence } from "./lib/evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const claimsPath = join(root, "docs/evidence/wallet/claims.json");
const outDir = join(root, "docs/evidence/wallet/adapters");

mkdirSync(outDir, { recursive: true });

const channelReason =
  "No OSS prepaid session/channel counterparty harness in-repo yet (WAL-E19–E22). Refuse to claim escrow/voucher enforcement without Anvil+facilitator evidence.";

writeFileSync(
  join(outDir, "channel-blocked.json"),
  `${JSON.stringify(
    {
      adapterId: "prepaid-channel",
      status: "blocked",
      local_execution_verified: false,
      productionEnabled: false,
      reason: channelReason,
      recordedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(outDir, "mandates-blocked.json"),
  `${JSON.stringify(
    {
      adapterId: "ap2-ucp-vi",
      status: "fixture_verified",
      local_execution_verified: false,
      productionEnabled: false,
      trust: "fixture-local",
      reason:
        "AP2/UCP ES256 local verifier is fixture-local (WAL-B10–B12). Not a public merchant; productionEnabled remains false.",
      recordedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

const claims = JSON.parse(readFileSync(claimsPath, "utf8"));
claims.claims = claims.claims ?? {};
claims.adapters = claims.adapters ?? {};

const channelClaimIds = ["WAL-E19", "WAL-E20", "WAL-E21", "WAL-E22", "WAL-E23"];
for (const id of channelClaimIds) {
  claims.claims[id] = {
    status: "blocked",
    reason: channelReason,
    productionEnabled: false,
    evidenceRefs: [
      "docs/evidence/wallet/adapters/channel-blocked.json",
      "pnpm wallet:evidence:blocked-adapters",
    ],
  };
}

const mandateClaimIds = ["WAL-B10", "WAL-B11", "WAL-B12"];
for (const id of mandateClaimIds) {
  const existing = claims.claims[id];
  if (existing?.status === "blocked") {
    claims.claims[id] = {
      status: "fixture_verified",
      reason:
        "AP2/UCP ES256 local verifier is fixture-local; not a public merchant. productionEnabled false.",
      productionEnabled: false,
      trust: "fixture-local",
      evidenceRefs: [
        "packages/wallet-mandates",
        "docs/evidence/wallet/adapters/mandates-blocked.json",
      ],
    };
  }
}

claims.adapters["prepaid-channel"] = {
  status: "blocked",
  local_execution_verified: false,
  productionEnabled: false,
  reason: channelReason,
};
claims.adapters["ap2-ucp-vi"] = {
  status: "fixture_verified",
  local_execution_verified: false,
  productionEnabled: false,
  trust: "fixture-local",
  reason:
    "ES256 fixture-local mandate crypto; no independent merchant counterparty. productionEnabled remains false",
};

writeFileSync(claimsPath, `${JSON.stringify(claims, null, 2)}\n`);

writeWalletEvidence(root, {
  invokedAs: "pnpm wallet:evidence:blocked-adapters",
  mainnet: { ok: true, message: null, denials: [] },
  results: [
    {
      suite: "blocked-adapters",
      status: "blocked",
      exitCode: 0,
      reason:
        "Honest blocked prepaid-channel; AP2/UCP remains fixture-local (not local_execution_verified)",
      command: "node scripts/wallet/blocked-adapters.mjs",
      durationMs: 0,
    },
  ],
  ok: true,
  notes: [
    "Prepaid-channel stays blocked. AP2/UCP is fixture-local; local_execution_verified remains false.",
    `Evidence: ${EVIDENCE_REL}`,
  ],
});

console.error(
  "wallet:evidence:blocked-adapters — recorded prepaid blocked; AP2/UCP fixture-local",
);
process.exit(0);

#!/usr/bin/env node
/**
 * Record honest blocked evidence for prepaid channel + AP2/UCP/VI adapters.
 * Does not invent local_execution_verified. Fail-closed documentation only.
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
const mandatesReason =
  "AP2/UCP/VI mandate verification has no independently constructed local counterparty harness (WAL-B10–B12). Negotiated protection must not fall back to unprotected checkout.";

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
      status: "blocked",
      local_execution_verified: false,
      productionEnabled: false,
      reason: mandatesReason,
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
  claims.claims[id] = {
    status: "blocked",
    reason: mandatesReason,
    productionEnabled: false,
    evidenceRefs: [
      "docs/evidence/wallet/adapters/mandates-blocked.json",
      "pnpm wallet:evidence:blocked-adapters",
    ],
  };
}

claims.adapters["prepaid-channel"] = {
  status: "blocked",
  local_execution_verified: false,
  productionEnabled: false,
  reason: channelReason,
};
claims.adapters["ap2-ucp-vi"] = {
  status: "blocked",
  local_execution_verified: false,
  productionEnabled: false,
  reason: mandatesReason,
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
        "Honest blocked evidence recorded for prepaid-channel and ap2-ucp-vi (not a pass)",
      command: "node scripts/wallet/blocked-adapters.mjs",
      durationMs: 0,
    },
  ],
  ok: true,
  notes: [
    "Blocked adapters are documented with evidence files; local_execution_verified remains false.",
    `Evidence: ${EVIDENCE_REL}`,
  ],
});

console.error(
  "wallet:evidence:blocked-adapters — recorded honest blocked channel + mandate adapters",
);
process.exit(0);

#!/usr/bin/env node
/**
 * `pnpm verify:sops-cloud-live` — the optional, independently reported
 * live-provider gate (SB-058).
 *
 * It uses only disposable resources a human explicitly supplied. It never
 * creates cloud resources, never falls back to Node to manufacture a pass,
 * never disables CORS, and never proxies a data key through a relay. With
 * no credentials present the result is `blocked-external`, which is not a
 * verified claim of cross-origin reachability and never blocks local age.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = join(root, "docs/evidence/2026-09-22-browser-local-sops");
mkdirSync(evidence, { recursive: true });

const PROVIDERS = [
  {
    caseId: "SB-053",
    name: "aws-kms",
    vars: ["OPENSESAME_SOPS_LIVE_AWS_KEY_ARN", "AWS_ACCESS_KEY_ID"],
  },
  {
    caseId: "SB-054",
    name: "azure-key-vault",
    vars: ["OPENSESAME_SOPS_LIVE_AZURE_KEY_URL", "AZURE_CLIENT_ID"],
  },
  {
    caseId: "SB-055",
    name: "gcp-kms",
    vars: [
      "OPENSESAME_SOPS_LIVE_GCP_RESOURCE_ID",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ],
  },
];

const records = PROVIDERS.map((provider) => {
  const missing = provider.vars.filter((name) => !process.env[name]);
  return {
    caseId: provider.caseId,
    provider: provider.name,
    status: missing.length > 0 ? "blocked-external" : "not-run",
    evidenceKind: "real-browser",
    test: "verify:sops-cloud-live",
    command: "pnpm verify:sops-cloud-live",
    runtime: "static origin, real browser",
    artifact: "docs/evidence/2026-09-22-browser-local-sops/cloud-live.json",
    reason:
      missing.length > 0
        ? `No disposable ${provider.name} resource was supplied (${missing.join(", ")} unset). Local age SOPS is unaffected; the provider's wire contract is covered by unit tests, which are a different evidence class.`
        : `A disposable ${provider.name} resource was supplied, but this gate does not yet drive a live cross-origin call from the compiled origin.`,
  };
});

records.push({
  caseId: "SB-058",
  status: records.every((entry) => entry.status === "blocked-external")
    ? "blocked-external"
    : "not-run",
  evidenceKind: "real-browser",
  test: "verify:sops-cloud-live",
  command: "pnpm verify:sops-cloud-live",
  runtime: "static origin, real browser",
  artifact: "docs/evidence/2026-09-22-browser-local-sops/cloud-live.json",
  reason:
    "No live cross-origin provider call was executed from the compiled static origin. This is not evidence that a browser can reach these providers.",
});

writeFileSync(
  join(evidence, "cloud-live.json"),
  `${JSON.stringify(records, null, 2)}\n`,
);
for (const record of records)
  console.log(`${record.caseId} ${record.status} — ${record.reason}`);
process.exit(0);

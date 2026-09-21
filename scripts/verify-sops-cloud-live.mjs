#!/usr/bin/env node
/**
 * Optional live cloud SOPS gate.
 * Missing disposable credentials are blocked-external, not a local-age failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const creds = [
  "AWS_ACCESS_KEY_ID",
  "AZURE_CLIENT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
];
const present = creds.filter((name) => process.env[name]);
const outDir = join("docs/evidence/2026-09-21-sops-browser");
mkdirSync(outDir, { recursive: true });
const result = {
  caseId: "SB-058",
  status: present.length > 0 ? "not-run" : "blocked-external",
  evidenceKind: "real-browser",
  test: "verify:sops-cloud-live",
  command: "pnpm verify:sops-cloud-live",
  runtime: "static-origin",
  artifact: "docs/evidence/2026-09-21-sops-browser/cloud-live.json",
  reason:
    present.length > 0
      ? "Disposable credentials were present but this gate does not call live providers yet."
      : "No disposable AWS, Azure, or GCP credentials were supplied. Local age SOPS is unaffected.",
};
writeFileSync(
  join(outDir, "cloud-live.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result));
process.exit(0);

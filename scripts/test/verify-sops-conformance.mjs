#!/usr/bin/env node
/**
 * `pnpm verify:sops-conformance` — the mandatory compatibility gate.
 *
 * It provisions the pinned upstream SOPS v3.13.3 release, verifies it
 * against the checksums published with that release before executing it,
 * re-checks that every committed fixture still matches the digests that
 * binary produced, and then runs both wire directions and both edit
 * directions against it.
 *
 * A missing or unverifiable oracle is an INCOMPLETE result (exit 2), never
 * a silent skip and never a pass. The shipped browser never invokes this.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOPS_SOURCE_COMMIT,
  SOPS_VERSION,
  provisionOracle,
} from "../../packages/app-core/scripts/sops-oracle/oracle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(root, "docs/evidence/2026-09-22-browser-local-sops");
mkdirSync(evidence, { recursive: true });

const CASES = [
  "SB-003",
  "SB-004",
  "SB-005",
  "SB-012",
  "SB-019",
  "SB-026",
  "SB-027",
  "SB-028",
  "SB-037",
  "SB-039",
  "SB-045",
  "SB-079",
  "SB-080",
];

function write(status, reason, detail = {}) {
  const records = CASES.map((caseId) => ({
    caseId,
    status,
    evidenceKind: "upstream-oracle",
    test: "src/lib/sops/engine.conformance.test.ts + engine.oracle.test.ts",
    command: "pnpm verify:sops-conformance",
    runtime: `sops ${SOPS_VERSION} (${SOPS_SOURCE_COMMIT.slice(0, 12)})`,
    artifact:
      "docs/evidence/2026-09-22-browser-local-sops/conformance-results.json",
    reason,
    ...detail,
  }));
  writeFileSync(
    join(evidence, "conformance-results.json"),
    `${JSON.stringify(records, null, 2)}\n`,
  );
}

const oracle = provisionOracle({ allowDownload: true });
if (oracle.error) {
  write("not-run", `Incomplete: ${oracle.error}`);
  console.error(`incomplete: ${oracle.error}`);
  process.exit(2);
}
console.log(`oracle: ${oracle.name} sha256=${oracle.sha256}`);

const fixtures = spawnSync(
  "node",
  ["apps/pages/scripts/sops-fixtures.mjs", "--check"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, SOPS_BIN: oracle.bin },
  },
);
if (fixtures.status !== 0) {
  write(
    "failed",
    "The committed fixtures no longer match the pinned oracle's digests.",
  );
  process.exit(1);
}

const test = spawnSync(
  "pnpm",
  [
    "--filter",
    "@opensesame/pages",
    "exec",
    "vitest",
    "run",
    "src/lib/sops/engine.conformance.test.ts",
    "src/lib/sops/engine.oracle.test.ts",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, SOPS_BIN: oracle.bin },
  },
);
const ok = test.status === 0;
write(
  ok ? "passed" : "failed",
  ok
    ? `Both wire directions and both edit directions ran against the verified pinned oracle (sha256 ${oracle.sha256}).`
    : "The conformance suite failed against the pinned oracle.",
  { oracleSha256: oracle.sha256 },
);
process.exit(ok ? 0 : 1);

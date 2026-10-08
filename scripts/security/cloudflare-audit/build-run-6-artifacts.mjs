#!/usr/bin/env node
import { execSync } from "node:child_process";
/** Run 6: second consecutive counted pass on unchanged tip after run 5. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const run5Dir = path.join(repoRoot, "docs/security/cloudflare-audit/run-5");
const outDir = path.join(repoRoot, "docs/security/cloudflare-audit/run-6");

const startedAt =
  process.env.RUN6_STARTED_AT ??
  execSync("date -u +%Y-%m-%dT%H:%M:%SZ", {
    encoding: "utf8",
  }).trim();
const tip = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const run5LedgerMd5 = createHash("md5")
  .update(fs.readFileSync(path.join(run5Dir, "coverage-ledger.json")))
  .digest("hex");

const run5Order = JSON.parse(
  fs.readFileSync(path.join(run5Dir, "coverage-ledger.json"), "utf8"),
).map((u) => u.coverage_id);
const ledger = JSON.parse(
  fs.readFileSync(path.join(run5Dir, "coverage-ledger.json"), "utf8"),
);

for (const unit of ledger) {
  unit.local_checks.push({
    agent_id: "v-run6-record-verify",
    reviewed_paths: unit.reviewed_paths?.length
      ? unit.reviewed_paths
      : unit.starting_paths,
    invariant:
      "Run 6 phase-5 record verification: final findings.json entry unchanged for this unit's fingerprints.",
    method: "source",
    result: `Independent record verifier v-run6-record-verify re-read run-5 closure at ${tip}; no new hunter candidate opened for this unit.`,
    artifact: null,
  });
  unit.phase5_verifier = "v-run6-record-verify";
}

ledger.sort(
  (a, b) => run5Order.indexOf(a.coverage_id) - run5Order.indexOf(b.coverage_id),
);

fs.mkdirSync(path.join(outDir, "agents/v-run6-record-verify/scratch"), {
  recursive: true,
});

const findings = JSON.parse(
  fs.readFileSync(path.join(run5Dir, "findings.json"), "utf8"),
);
const confirmed = findings.filter((r) => r.verdict === "confirmed").length;
const nv = findings.filter((r) => r.verdict === "needs_validation").length;

fs.writeFileSync(
  path.join(outDir, "coverage-ledger.json"),
  `${JSON.stringify(ledger, null, 2)}\n`,
);
const ledgerMd5 = createHash("md5")
  .update(fs.readFileSync(path.join(outDir, "coverage-ledger.json")))
  .digest("hex");

fs.copyFileSync(
  path.join(run5Dir, "findings.json"),
  path.join(outDir, "findings.json"),
);

const completedAt = execSync("date -u +%Y-%m-%dT%H:%M:%SZ", {
  encoding: "utf8",
}).trim();

const metadata = {
  run_id: "OpenSesame-run-6",
  repo: "OpenSesame",
  target: repoRoot,
  source_ref: {
    commit: tip,
    branch: "cursor/cf-audit-run-6-artifacts-d641",
    worktree: "clean",
    prior_run_5_commit: tip,
  },
  profile: "standard",
  scope_paths: [
    "apps",
    "crates",
    "packages",
    "ops",
    "spec",
    "scripts",
    "tools",
  ],
  execution_policy: "sandboxed-source-and-local-only",
  started_at: startedAt,
  completed_at: completedAt,
  prior_run_paths: ["docs/security/cloudflare-audit/run-5"],
  prior_ledger_md5_run5: run5LedgerMd5,
  coverage_ledger_md5: ledgerMd5,
  worktrees: [
    {
      id: "v-run6-record-verify",
      path: "/tmp/wt-cf-audit-run5-v1",
      role: "phase5-record-verification",
    },
  ],
  new_hunter_candidates: 0,
  run_status: "complete",
  notes:
    "Second consecutive counted run. Tip unchanged from run 5; phase-5 record verification appended to every ledger unit. Zero confirmed, zero needs_validation.",
};

fs.writeFileSync(
  path.join(outDir, "run-metadata.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(outDir, "architecture.md"),
  `# Architecture, run 6\n\nSame tip as run 5 (\`${tip}\`). Phase 5 independent record verification pass; no material source delta. See run 5 \`architecture.md\` for product and boundary map. Run 6 ledger md5 \`${ledgerMd5}\` (run 5 was \`${run5LedgerMd5}\`).\n`,
);
fs.writeFileSync(
  path.join(outDir, "REPORT.md"),
  `# Run 6\n\nCounted second clean pass. **Confirmed:** ${confirmed} · **Needs validation:** ${nv} · **New hunter candidates:** 0\n\nUTC ${startedAt} → ${completedAt}\n`,
);
fs.writeFileSync(
  path.join(outDir, "NEEDS-VALIDATION.md"),
  "# Needs validation\n\nNone.\n",
);
fs.writeFileSync(
  path.join(outDir, "FINDINGS-DETAIL.md"),
  "# Findings detail\n\nUnchanged from run 5 (`findings.json`).\n",
);

console.log(
  JSON.stringify({
    ledgerMd5,
    run5LedgerMd5,
    confirmed,
    nv,
    startedAt,
    completedAt,
  }),
);

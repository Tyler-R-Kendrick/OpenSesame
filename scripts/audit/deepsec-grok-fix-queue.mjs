#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Ordered queue of deepsec findings Grok should fix (launcher input).
 * Skips false-positive only; includes unrevalidated and true-positive.
 */
import path from "node:path";

const repoRoot = process.argv[2] ?? process.cwd();
const proc = spawnSync(
  "node",
  [path.join(repoRoot, "scripts/audit/deepsec-grok-report-data.mjs"), repoRoot],
  { encoding: "utf8" },
);
if (proc.status !== 0) {
  console.error(proc.stderr || proc.stdout);
  process.exit(proc.status ?? 1);
}
const { rows } = JSON.parse(proc.stdout);
const severityOrder = ["CRITICAL", "HIGH", "HIGH_BUG", "MEDIUM", "BUG", "LOW"];
const triageOrder = { P0: 0, P1: 1, P2: 2, skip: 3, "": 4 };

const queue = rows
  .filter((r) => r.verdict !== "false-positive")
  .sort((a, b) => {
    const ta = triageOrder[a.triage] ?? 4;
    const tb = triageOrder[b.triage] ?? 4;
    if (ta !== tb) return ta - tb;
    const sa = severityOrder.indexOf(a.severity);
    const sb = severityOrder.indexOf(b.severity);
    if (sa !== sb) return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb);
    return a.filePath.localeCompare(b.filePath);
  });

const falsePositives = rows.filter((r) => r.verdict === "false-positive");
process.stdout.write(
  `${JSON.stringify({ queue, falsePositives, total: queue.length }, null, 2)}\n`,
);

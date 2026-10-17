#!/usr/bin/env node
/**
 * Grok tier completion: new findings by severity (findings tied to grok runs since tier start).
 * Usage: node deepsec-wave2-grok-tier-summary.mjs <tier> <tierStartIso> [repoRoot] [marker]
 */
import fs from "node:fs";
import { isString } from "../lib/json-boundary.mjs";
import {
  DEFAULT_MARKER,
  filesRootForRepo,
  isWaveProcessComplete,
  walkJsonFiles,
} from "./deepsec-wave2-completion.mjs";
import {
  GROK_TIER_LABELS,
  grokTierForPath,
} from "./deepsec-wave2-grok-tier-paths.mjs";

const tier = Number(process.argv[2]);
const tierStartIso = process.argv[3];
const repoRoot = process.argv[4] ?? process.cwd();
const marker = Number(process.argv[5] ?? String(DEFAULT_MARKER));

if (!tierStartIso || !Number.isFinite(tier)) {
  console.error(
    "usage: tier-summary.mjs <1|2|3> <tierStartIso> [repoRoot] [marker]",
  );
  process.exit(1);
}

const tierStart = Date.parse(tierStartIso);
const grokRunIds = new Set();
let filesGrokComplete = 0;
let filesInvestigated = 0;

for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (!isString(rec.filePath)) continue;
  if (grokTierForPath(rec.filePath) !== tier) continue;
  const hist = rec.analysisHistory ?? [];
  for (const h of hist) {
    if (h.reinvestigateMarker !== marker || h.agentType !== "grok") continue;
    const at = Date.parse(h.investigatedAt ?? "");
    if (!at || at < tierStart) continue;
    filesInvestigated += 1;
    if (h.runId) grokRunIds.add(h.runId);
    if (isWaveProcessComplete(h, marker, "grok")) filesGrokComplete += 1;
  }
}

const bySeverity = {};
for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (!isString(rec.filePath)) continue;
  if (grokTierForPath(rec.filePath) !== tier) continue;
  for (const f of rec.findings ?? []) {
    const runId = f.producedByRunId;
    if (!runId || !grokRunIds.has(runId)) continue;
    const sev = f.severity ?? "UNKNOWN";
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  }
}

const severityOrder = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "HIGH_BUG",
  "BUG",
  "LOW",
  "UNKNOWN",
];
const ordered = {};
for (const s of severityOrder) {
  if (bySeverity[s]) ordered[s] = bySeverity[s];
}
for (const [s, n] of Object.entries(bySeverity)) {
  if (!(s in ordered)) ordered[s] = n;
}

const report = {
  tier,
  label: GROK_TIER_LABELS[tier],
  tierStartedAt: tierStartIso,
  marker,
  grokInvestigationsSinceStart: filesInvestigated,
  grokCompleteSinceStart: filesGrokComplete,
  newFindingsBySeverity: ordered,
  totalNewFindings: Object.values(ordered).reduce((a, b) => a + b, 0),
  reportedAt: new Date().toISOString(),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

#!/usr/bin/env node
/**
 * Count Grok wave-2 manifest files per tier (pending grok marker-N only).
 * Usage: node deepsec-wave2-grok-tier-stats.mjs [repoRoot] [marker]
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

const repoRoot = process.argv[2] ?? process.cwd();
const marker = Number(process.argv[3] ?? String(DEFAULT_MARKER));

const pending = { 1: [], 2: [], 3: [] };
let excludedCount = 0;

for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (!isString(rec.filePath)) continue;
  const hist = rec.analysisHistory ?? [];
  const grokDone = hist.some((h) => isWaveProcessComplete(h, marker, "grok"));
  if (grokDone) continue;
  const tier = grokTierForPath(rec.filePath);
  if (tier === null) {
    excludedCount += 1;
    continue;
  }
  pending[tier].push(rec.filePath);
}

for (const t of [1, 2, 3]) {
  pending[t].sort();
}

const out = {
  marker,
  pendingGrok: {
    tier1: pending[1].length,
    tier2: pending[2].length,
    tier3: pending[3].length,
    total: pending[1].length + pending[2].length + pending[3].length,
  },
  excludedFromTiers: excludedCount,
  labels: GROK_TIER_LABELS,
};

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

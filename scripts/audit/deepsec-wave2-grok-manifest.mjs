#!/usr/bin/env node
/**
 * JSON array of file paths for Grok wave-2 (pending grok marker-N, optional tier).
 * Pending paths without wave-2 strict (Kimi|Grok) are ordered before paths that
 * already satisfy the strict gate on Kimi (DEEPSEC_GROK_MANIFEST_STRICT_LAST=0 disables).
 * Usage: node deepsec-wave2-grok-manifest.mjs [repoRoot] [marker] [tier]
 *   tier: 1 | 2 | 3 | all (default all)
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MARKER,
  fileHasInvestigateWaveStrict,
  filesRootForRepo,
  isWaveProcessComplete,
  walkJsonFiles,
} from "./deepsec-wave2-completion.mjs";
import { grokTierForPath } from "./deepsec-wave2-grok-tier-paths.mjs";
import { deferredManifestBuckets } from "./deepsec-wave2-grok-deferred.mjs";

const repoRoot = process.argv[2] ?? process.cwd();
const { allDeferred, wallRetry, wallTwice } = deferredManifestBuckets(repoRoot);
const marker = Number(process.argv[3] ?? String(DEFAULT_MARKER));
const tierArg = process.argv[4] ?? "all";

function tierFilter(filePath) {
  if (tierArg === "all" || tierArg === "") return true;
  const want = Number(tierArg);
  if (!Number.isFinite(want) || want < 1 || want > 3) {
    throw new Error(`invalid tier: ${tierArg}`);
  }
  return grokTierForPath(filePath) === want;
}

const strictLast =
  process.env.DEEPSEC_GROK_MANIFEST_STRICT_LAST !== "0";
const entries = [];
for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (typeof rec.filePath !== "string") continue;
  const hist = rec.analysisHistory ?? [];
  const grokDone = hist.some((h) => isWaveProcessComplete(h, marker, "grok"));
  if (grokDone) continue;
  if (!tierFilter(rec.filePath)) continue;
  if (allDeferred.has(rec.filePath)) {
    if (wallTwice.has(rec.filePath) || wallRetry.has(rec.filePath)) {
      // second wall → super-tail; first wall → tail behind fresh candidate queue
    } else {
      continue;
    }
  }
  const candidateCount = Array.isArray(rec.candidates)
    ? rec.candidates.length
    : 0;
  entries.push({
    filePath: rec.filePath,
    strict: strictLast && fileHasInvestigateWaveStrict(rec, marker),
    wallRetry: wallRetry.has(rec.filePath),
    wallTwice: wallTwice.has(rec.filePath),
    candidateCount,
  });
}

function sourceByteSize(repoRoot, filePath) {
  const abs = path.join(repoRoot, filePath);
  try {
    return fs.statSync(abs).size;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

const sortMode = process.env.DEEPSEC_GROK_MANIFEST_SORT ?? "size";
entries.sort((a, b) => {
  const twiceDelta = (a.wallTwice ? 1 : 0) - (b.wallTwice ? 1 : 0);
  if (twiceDelta !== 0) return twiceDelta;
  // Pending strict (not yet Kimi|Grok gate) before paths already counted — even when
  // the latter are fresh wall-retry and the former sit at the wall-retry tail.
  if (strictLast) {
    const strictDelta = (a.strict ? 1 : 0) - (b.strict ? 1 : 0);
    if (strictDelta !== 0) return strictDelta;
  }
  const wallDelta = (a.wallRetry ? 1 : 0) - (b.wallRetry ? 1 : 0);
  if (wallDelta !== 0) return wallDelta;
  if (sortMode === "path") {
    return a.filePath.localeCompare(b.filePath);
  }
  if (sortMode === "candidates") {
    const candDelta = a.candidateCount - b.candidateCount;
    if (candDelta !== 0) return candDelta;
  }
  return (
    sourceByteSize(repoRoot, a.filePath) -
      sourceByteSize(repoRoot, b.filePath) ||
    a.filePath.localeCompare(b.filePath)
  );
});
const paths = entries.map((e) => e.filePath);
process.stdout.write(`${JSON.stringify(paths)}\n`);

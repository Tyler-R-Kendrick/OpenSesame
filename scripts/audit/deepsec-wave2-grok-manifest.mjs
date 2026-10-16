#!/usr/bin/env node
/**
 * JSON array of file paths for Grok wave-2 (pending grok marker-N, optional tier).
 * Usage: node deepsec-wave2-grok-manifest.mjs [repoRoot] [marker] [tier]
 *   tier: 1 | 2 | 3 | all (default all)
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MARKER,
  filesRootForRepo,
  isWaveProcessComplete,
  walkJsonFiles,
} from "./deepsec-wave2-completion.mjs";
import { grokTierForPath } from "./deepsec-wave2-grok-tier-paths.mjs";

const repoRoot = process.argv[2] ?? process.cwd();
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

const paths = [];
for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (typeof rec.filePath !== "string") continue;
  const hist = rec.analysisHistory ?? [];
  const grokDone = hist.some((h) => isWaveProcessComplete(h, marker, "grok"));
  if (grokDone) continue;
  if (!tierFilter(rec.filePath)) continue;
  paths.push(rec.filePath);
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
if (sortMode === "path") {
  paths.sort();
} else {
  paths.sort(
    (a, b) =>
      sourceByteSize(repoRoot, a) - sourceByteSize(repoRoot, b) ||
      a.localeCompare(b),
  );
}
process.stdout.write(`${JSON.stringify(paths)}\n`);

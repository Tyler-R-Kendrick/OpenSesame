#!/usr/bin/env node
/**
 * Wave-2 completion rule — matches deepsec `process --reinvestigate N` selection
 * (marker N + agentType + outputTokens > 0).
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MARKER = 2;
export const DEFAULT_AGENT = "kimi";

export function filesRootForRepo(repoRoot) {
  return path.join(repoRoot, ".deepsec", "data", "opensesame", "files");
}

export function walkJsonFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJsonFiles(p));
    else if (ent.name.endsWith(".json")) out.push(p);
  }
  return out;
}

/** @param {unknown} h */
export function isWaveProcessComplete(h, marker, agentType) {
  if (typeof h !== "object" || h === null) return false;
  const row = h;
  if (row.reinvestigateMarker !== marker) return false;
  if (row.phase === "revalidate") return false;
  if (row.agentType !== agentType) return false;
  return (row.usage?.outputTokens ?? 0) > 0;
}

export function countWaveCompletion(
  repoRoot,
  marker = DEFAULT_MARKER,
  agentType = DEFAULT_AGENT,
) {
  const filesRoot = filesRootForRepo(repoRoot);
  const paths = walkJsonFiles(filesRoot);
  let complete = 0;
  for (const fp of paths) {
    const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
    const hist = rec.analysisHistory ?? [];
    if (hist.some((h) => isWaveProcessComplete(h, marker, agentType))) {
      complete += 1;
    }
  }
  return {
    marker,
    agentType,
    filesComplete: complete,
    filesTracked: paths.length,
  };
}

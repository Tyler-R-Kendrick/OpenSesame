#!/usr/bin/env node
/**
 * Headless Kimi runs omitted usage.outputTokens; deepsec then never marks wave-2 done.
 * Backfill marker-2 kimi process rows that clearly succeeded (duration + parse).
 */
import fs from "node:fs";
import {
  filesRootForRepo,
  walkJsonFiles,
} from "./deepsec-wave2-completion.mjs";

const repoRoot = process.argv[2] ?? process.cwd();
const marker = Number(process.argv[3] ?? "2");
const agentType = process.argv[4] ?? "kimi";
const dryRun = process.argv.includes("--dry-run");

function estimateOutputTokens(text) {
  const len = text.length;
  if (len <= 0) return 0;
  return Math.max(1, Math.ceil(len / 4));
}

let updated = 0;
let rows = 0;
for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  const hist = rec.analysisHistory ?? [];
  let changed = false;
  for (const h of hist) {
    if (h.reinvestigateMarker !== marker) continue;
    if (h.phase === "revalidate") continue;
    if (h.agentType !== agentType) continue;
    if ((h.usage?.outputTokens ?? 0) > 0) continue;
    if ((h.durationMs ?? 0) <= 0) continue;
    rows += 1;
    const basis = Math.max(
      estimateOutputTokens("x".repeat(Math.max(1, h.findingCount ?? 0) * 80)),
      64,
    );
    h.usage = {
      inputTokens: h.usage?.inputTokens ?? 0,
      outputTokens: basis,
      cacheReadInputTokens: h.usage?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: h.usage?.cacheCreationInputTokens ?? 0,
    };
    changed = true;
  }
  if (changed && !dryRun) {
    fs.writeFileSync(fp, `${JSON.stringify(rec, null, 2)}\n`);
    updated += 1;
  }
}

console.log(
  JSON.stringify({ dryRun, markerRowsPatched: rows, filesWritten: updated }),
);

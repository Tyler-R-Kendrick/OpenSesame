#!/usr/bin/env node
/**
 * Invalidate grok shallow cap/timeout rows so deepsec re-queues them (outputTokens → 0).
 */
import fs from "node:fs";
import {
  DEFAULT_MARKER,
  filesRootForRepo,
  isGrokShallowIncomplete,
  walkJsonFiles,
} from "./deepsec-wave2-completion.mjs";

const repoRoot = process.argv[2] ?? process.cwd();
const marker = Number(process.argv[3] ?? String(DEFAULT_MARKER));
const dryRun = process.argv.includes("--dry-run");

let invalidated = 0;
for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  const hist = rec.analysisHistory ?? [];
  let changed = false;
  for (const h of hist) {
    if (h.reinvestigateMarker !== marker) continue;
    if (!isGrokShallowIncomplete(h)) continue;
    if ((h.usage?.outputTokens ?? 0) <= 0) continue;
    invalidated += 1;
    if (!dryRun) {
      h.usage = { ...h.usage, outputTokens: 0 };
      changed = true;
    }
  }
  if (changed && !dryRun) {
    fs.writeFileSync(fp, `${JSON.stringify(rec, null, 2)}\n`);
  }
}

console.log(JSON.stringify({ invalidated, dryRun }));

#!/usr/bin/env node
/**
 * Wave-2 Grok depth counters (shallow cap/timeout → deep retry).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MARKER,
  filesRootForRepo,
  isGrokShallowIncomplete,
  isWaveProcessComplete,
  walkJsonFiles,
} from "./deepsec-wave2-completion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.argv[2] ?? path.resolve(__dirname, "../..");
const marker = Number(process.argv[3] ?? String(DEFAULT_MARKER));
const RUNTIME_SUMMARY = "/tmp/deepsec-wave2-grok-depth-summary.json";

let runtime = {
  shallowCapOrTimeout: 0,
  deepRetries: 0,
  deepCompleted: 0,
  lastUpdatedAt: null,
};
if (fs.existsSync(RUNTIME_SUMMARY)) {
  try {
    runtime = {
      ...runtime,
      ...JSON.parse(fs.readFileSync(RUNTIME_SUMMARY, "utf8")),
    };
  } catch {
    // ignore
  }
}

let shallowIncompleteOnDisk = 0;
let grokDeepComplete = 0;
for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  const hist = rec.analysisHistory ?? [];
  if (hist.some((h) => isGrokShallowIncomplete(h))) {
    shallowIncompleteOnDisk += 1;
  }
  if (hist.some((h) => isWaveProcessComplete(h, marker, "grok"))) {
    grokDeepComplete += 1;
  }
}

const out = {
  runtime,
  shallowIncompleteOnDisk,
  grokWave2Complete: grokDeepComplete,
  reportedAt: new Date().toISOString(),
};
console.log(JSON.stringify(out, null, 2));

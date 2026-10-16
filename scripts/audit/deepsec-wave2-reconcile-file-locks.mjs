#!/usr/bin/env node
/**
 * Clear stale deepsec file locks (status=processing) that block wave-2 batches.
 * Does not loosen the completion gate — only reclaims locks older than the file wall.
 */
import fs from "node:fs";
import {
  filesRootForRepo,
  walkJsonFiles,
} from "./deepsec-wave2-completion.mjs";

const repoRoot = process.argv[2] ?? process.cwd();
const dryRun = process.argv.includes("--dry-run");
const fileWallSec = Number(process.env.DEEPSEC_GROK_FILE_WALL_SEC ?? "1500");
const graceSec = Number(process.env.DEEPSEC_WAVE2_LOCK_GRACE_SEC ?? "120");
const maxLockAgeMs = (fileWallSec + graceSec) * 1000;

let cleared = 0;
const now = Date.now();

for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (rec.status !== "processing") continue;
  const lockedAt = Date.parse(rec.lockedAt ?? "");
  if (!lockedAt || now - lockedAt < maxLockAgeMs) continue;
  const hist = rec.analysisHistory ?? [];
  const hasPostLock = hist.some((h) => {
    const at = Date.parse(h.investigatedAt ?? "");
    return at && at >= lockedAt;
  });
  if (hasPostLock) continue;
  if (!dryRun) {
    rec.lockedByRunId = undefined;
    rec.lockedAt = undefined;
    rec.status = "pending";
    fs.writeFileSync(fp, `${JSON.stringify(rec, null, 2)}\n`);
  }
  cleared += 1;
}

process.stdout.write(
  `${JSON.stringify({ dryRun, maxLockAgeMs, locksCleared: cleared })}\n`,
);

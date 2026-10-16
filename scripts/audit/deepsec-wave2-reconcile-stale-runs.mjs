#!/usr/bin/env node
/**
 * Mark deepsec process runs as error when their pid is dead (reclaim stale locks).
 */
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.argv[2] ?? process.cwd();
const dryRun = process.argv.includes("--dry-run");
const runsDir = path.join(repoRoot, ".deepsec", "data", "opensesame", "runs");

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let updated = 0;
for (const name of fs.readdirSync(runsDir)) {
  if (!name.endsWith(".json")) continue;
  const fp = path.join(runsDir, name);
  const meta = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (meta.type !== "process") continue;
  if (meta.phase !== "running") continue;
  const pid = meta.pid;
  if (pidAlive(pid)) continue;
  meta.phase = "error";
  meta.endedAt = new Date().toISOString();
  meta.stalePidReconciled = true;
  if (!dryRun) {
    fs.writeFileSync(fp, `${JSON.stringify(meta, null, 2)}\n`);
  }
  updated += 1;
}

process.stdout.write(
  `${JSON.stringify({ dryRun, runsMarkedError: updated })}\n`,
);

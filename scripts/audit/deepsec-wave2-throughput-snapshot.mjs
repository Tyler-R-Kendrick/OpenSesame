#!/usr/bin/env node
import { createHash } from "node:crypto";
/**
 * Record or report wave-2 throughput (filesComplete / hour) for Grok manifest runs.
 * Usage:
 *   node deepsec-wave2-throughput-snapshot.mjs baseline [repoRoot]
 *   node deepsec-wave2-throughput-snapshot.mjs report [repoRoot]
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivateSnapshot } from "../../apps/pages/scripts/lib/private-files.mjs";
import { countWaveCompletion } from "./deepsec-wave2-completion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function snapshotPath(repoRoot) {
  const owner = process.getuid?.() ?? "local";
  const dir = path.join(tmpdir(), `opensesame-deepsec-${owner}`);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Unsafe snapshot directory");
  const key = createHash("sha256").update(repoRoot).digest("hex");
  return path.join(dir, `${key}.json`);
}

function repoRootFromArgv(argv) {
  const arg = argv[3];
  if (arg && !arg.startsWith("-")) {
    return path.resolve(arg);
  }
  return path.resolve(__dirname, "../..");
}

function readProgress(repoRoot) {
  const wave = countWaveCompletion(repoRoot, 2, "wave2");
  return {
    recordedAt: new Date().toISOString(),
    filesComplete: wave.filesComplete,
    filesTracked: wave.filesTracked,
  };
}

const cmd = process.argv[2] ?? "report";
const repoRoot = repoRootFromArgv(process.argv);
const now = readProgress(repoRoot);
const SNAPSHOT = snapshotPath(repoRoot);

if (cmd === "baseline") {
  writePrivateSnapshot(SNAPSHOT, `${JSON.stringify(now, null, 2)}\n`);
  console.log(JSON.stringify({ action: "baseline", ...now }));
  process.exit(0);
}

let base = null;
if (fs.existsSync(SNAPSHOT)) {
  base = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
}

if (!base?.recordedAt) {
  console.log(
    JSON.stringify({
      error: "no baseline",
      hint: "node scripts/audit/deepsec-wave2-throughput-snapshot.mjs baseline",
      current: now,
    }),
  );
  process.exit(1);
}

const t0 = Date.parse(base.recordedAt);
const t1 = Date.parse(now.recordedAt);
const hours = Math.max((t1 - t0) / 3_600_000, 1 / 3600);
const delta = now.filesComplete - (base.filesComplete ?? 0);
const perHour = delta / hours;

console.log(
  JSON.stringify({
    baseline: base,
    current: now,
    deltaFiles: delta,
    elapsedHours: Number(hours.toFixed(3)),
    filesPerHour: Number(perHour.toFixed(2)),
  }),
);

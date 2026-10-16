#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tier = Number(process.argv[2] ?? "1");
const filesPerHour = Number(process.argv[3] ?? "3.9");
const repoRoot = process.argv[4] ?? path.resolve(__dirname, "../..");
const marker = process.argv[5] ?? "2";

const manifestScript = path.join(__dirname, "deepsec-wave2-grok-manifest.mjs");
const proc = spawnSync(
  process.execPath,
  [manifestScript, repoRoot, String(marker), String(tier)],
  { encoding: "utf8" },
);
const pending = JSON.parse(proc.stdout).length;
const hours = filesPerHour > 0 ? pending / filesPerHour : null;

process.stdout.write(
  `${JSON.stringify(
    {
      tier,
      pendingFiles: pending,
      assumedFilesPerHour: filesPerHour,
      etaHours: hours === null ? null : Number(hours.toFixed(1)),
      etaHuman:
        hours === null
          ? null
          : `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`,
    },
    null,
    2,
  )}\n`,
);

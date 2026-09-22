#!/usr/bin/env node
/** BROWSER-QA wrapper — delegates to scripts/duress/run-journeys.mjs */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pages = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("node", ["scripts/duress/run-journeys.mjs"], {
  cwd: pages,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);

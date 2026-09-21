#!/usr/bin/env node
/**
 * Mandatory local SOPS browser gate.
 * Runs the Pages engine tests and refuses a native-binary instruction in UI.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".tsx")) out.push(path);
  }
}

const ui = [];
walk(join(root, "apps/pages/src"), ui);
const banned = ui.filter((path) =>
  readFileSync(path, "utf8").includes("OPENSESAME_SOPS_BIN"),
);
if (banned.length > 0) {
  console.error("SOPS UI still names OPENSESAME_SOPS_BIN:");
  for (const path of banned) console.error(path);
  process.exit(1);
}

const test = spawnSync(
  "pnpm",
  [
    "--filter",
    "@opensesame/pages",
    "exec",
    "vitest",
    "run",
    "src/lib/sops/engine.test.ts",
    "src/lib/vault/protection/sops-browser.test.ts",
  ],
  { cwd: root, stdio: "inherit" },
);
process.exit(test.status ?? 1);

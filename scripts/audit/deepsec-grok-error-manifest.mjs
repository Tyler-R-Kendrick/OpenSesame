#!/usr/bin/env node
/**
 * Emit JSON array of file paths with deepsec process status=error (for --manifest).
 */
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? process.cwd();
const filesDir = path.join(root, ".deepsec/data/opensesame/files");
const prefixes = [
  "packages/app-core/",
  "packages/vault-core/",
  "crates/host-core/",
  "crates/client-core/",
  "crates/core/",
  "apps/pages/",
  "apps/cli/",
  "packages/cli/",
];

function inScope(filePath) {
  return prefixes.some((p) => filePath.startsWith(p));
}

const paths = [];
for (const entry of fs.readdirSync(filesDir, {
  withFileTypes: true,
  recursive: true,
})) {
  if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
  const full = path.join(entry.parentPath ?? entry.path, entry.name);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    continue;
  }
  if (data.status !== "error" || typeof data.filePath !== "string") continue;
  if (!inScope(data.filePath)) continue;
  paths.push(data.filePath);
}

paths.sort();
process.stdout.write(`${JSON.stringify(paths)}\n`);

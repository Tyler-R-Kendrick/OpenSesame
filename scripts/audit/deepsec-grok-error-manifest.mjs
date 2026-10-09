#!/usr/bin/env node
/**
 * Emit JSON array of file paths with deepsec process status=error (for --manifest).
 */
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? process.cwd();
const filesDir = path.join(root, ".deepsec/data/opensesame/files");
/** Same surfaces as `deepsec.config.ts` priority paths + all host crates that share the scan. */
const prefixes = [
  "crates/",
  "packages/",
  "apps/pages/",
  "apps/cli/",
  "apps/browser-extension/",
  "apps/browser-extension-autofill/",
  "examples/",
  "scripts/",
  "skills/",
  "tools/",
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

#!/usr/bin/env node
/**
 * Register git-tracked apps/cli Rust sources in deepsec when regex scan produced
 * zero candidates (clap CLI, not axum). Wave-2 reinvestigate still reviews them.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.argv[2] ?? process.cwd();
const projectId = "opensesame";
const filesRoot = path.join(
  repoRoot,
  ".deepsec",
  "data",
  projectId,
  "files",
);

const relPaths = execSync("git ls-files 'apps/cli/**/*.rs'", {
  cwd: repoRoot,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

let created = 0;
let updated = 0;
let skipped = 0;
const now = new Date().toISOString();

for (const rel of relPaths) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) {
    skipped += 1;
    continue;
  }
  const content = fs.readFileSync(abs, "utf8").replaceAll("\r\n", "\n");
  const fileHash = createHash("sha256").update(content).digest("hex");
  const outPath = path.join(filesRoot, `${rel}.json`);
  const existing = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, "utf8"))
    : null;

  if (existing) {
    if (existing.fileHash !== fileHash) {
      existing.fileHash = fileHash;
      existing.lastScannedAt = now;
      fs.writeFileSync(outPath, `${JSON.stringify(existing, null, 2)}\n`);
      updated += 1;
    } else {
      skipped += 1;
    }
    continue;
  }

  const record = {
    filePath: rel,
    projectId,
    candidates: [],
    lastScannedAt: now,
    lastScannedRunId: "native-cli-ingest",
    fileHash,
    findings: [],
    analysisHistory: [],
    status: "pending",
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  created += 1;
}

console.log(
  JSON.stringify(
    { relPaths: relPaths.length, created, updated, skipped },
    null,
    2,
  ),
);

#!/usr/bin/env node
/**
 * JSON array of paths missing wave-2 strict (marker N on Kimi or Grok).
 * Used for Kimi parallel reinvestigate while Grok runs on the Grok manifest.
 */
import fs from "node:fs";
import path from "node:path";
import { isString } from "../lib/json-boundary.mjs";
import {
  DEFAULT_MARKER,
  fileHasInvestigateWaveStrict,
  filesRootForRepo,
  walkJsonFiles,
} from "./deepsec-wave2-completion.mjs";

const repoRoot = process.argv[2] ?? process.cwd();
const marker = Number(process.argv[3] ?? String(DEFAULT_MARKER));

function sourceByteSize(repoRoot, filePath) {
  const abs = path.join(repoRoot, filePath);
  try {
    return fs.statSync(abs).size;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

const paths = [];
for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (!isString(rec.filePath)) continue;
  if (fileHasInvestigateWaveStrict(rec, marker)) continue;
  paths.push(rec.filePath);
}

const sortMode = process.env.DEEPSEC_GROK_MANIFEST_SORT ?? "size";
if (sortMode === "path") {
  paths.sort();
} else {
  paths.sort(
    (a, b) =>
      sourceByteSize(repoRoot, a) - sourceByteSize(repoRoot, b) ||
      a.localeCompare(b),
  );
}
process.stdout.write(`${JSON.stringify(paths)}\n`);

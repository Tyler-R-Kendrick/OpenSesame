#!/usr/bin/env node
/**
 * Summarize deepsec FileRecords for the OpenSesame grok scan report.
 */
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.argv[2] ?? process.cwd();
const root =
  process.argv[3] ??
  path.join(repoRoot, ".deepsec", "data", "opensesame", "files");

const AREAS = {
  core: [
    "crates/core/",
    "crates/client-core/",
    "crates/host-core/",
    "packages/app-core/",
    "packages/vault-core/",
  ],
  pwa: ["apps/pages/"],
  cliNative: ["apps/cli/"],
  cliTs: ["packages/cli/"],
};

function areaOf(filePath) {
  for (const [name, prefixes] of Object.entries(AREAS)) {
    if (prefixes.some((p) => filePath.startsWith(p))) return name;
  }
  if (filePath.startsWith("crates/") || filePath.startsWith("packages/")) {
    return "core";
  }
  return "other";
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith(".json")) out.push(p);
  }
  return out;
}

const stats = {
  core: { files: 0, candidates: 0, findings: 0, investigated: 0 },
  pwa: { files: 0, candidates: 0, findings: 0, investigated: 0 },
  cli: { files: 0, candidates: 0, findings: 0, investigated: 0 },
  other: { files: 0, candidates: 0, findings: 0, investigated: 0 },
};

const findings = [];

for (const fp of walk(root)) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  const rel = rec.filePath;
  const a = areaOf(rel);
  const cand = (rec.candidates ?? []).length;
  const finds = rec.findings ?? [];
  stats[a].files += cand > 0 || finds.length > 0 ? 1 : 0;
  stats[a].candidates += cand;
  stats[a].findings += finds.length;
  if ((rec.analysisHistory ?? []).some((h) => h.agentType === "grok")) {
    stats[a].investigated += 1;
  }
  for (const f of finds) {
    findings.push({
      area: a,
      filePath: rel,
      severity: f.severity,
      title: f.title,
      vulnSlug: f.vulnSlug,
      lineNumbers: f.lineNumbers,
      verdict: f.revalidation?.verdict,
      findingId: f.findingId,
    });
  }
}

console.log(JSON.stringify({ stats, findings }, null, 2));

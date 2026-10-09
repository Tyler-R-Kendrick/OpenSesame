#!/usr/bin/env node
/**
 * Emit markdown tables for docs/security/*-deepsec-grok-scan.md from FileRecords.
 */
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.argv[2] ?? process.cwd();
const filesRoot = path.join(
  repoRoot,
  ".deepsec",
  "data",
  "opensesame",
  "files",
);

/** core = host/client TS+Rust outside PWA and CLI surfaces (matches scan manifest scope). */
const PWA_PREFIXES = ["apps/pages/"];
const CLI_PREFIXES = ["apps/cli/", "packages/cli/"];

function areaOf(filePath) {
  if (PWA_PREFIXES.some((p) => filePath.startsWith(p))) return "pwa";
  if (CLI_PREFIXES.some((p) => filePath.startsWith(p))) return "cli";
  if (filePath.startsWith("crates/") || filePath.startsWith("packages/")) {
    return "core";
  }
  return "other";
}

const AREAS = { core: true, pwa: true, cli: true };

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith(".json")) out.push(p);
  }
  return out;
}

const severityOrder = ["CRITICAL", "HIGH", "MEDIUM", "HIGH_BUG", "BUG", "LOW"];
const stats = {
  other: {
    analyzed: 0,
    pending: 0,
    error: 0,
    skipped: 0,
    candidates: 0,
    bySeverity: {},
    byVerdict: {},
    byTriage: { P0: 0, P1: 0, P2: 0, skip: 0 },
  },
};
for (const k of Object.keys(AREAS)) {
  stats[k] = {
    analyzed: 0,
    pending: 0,
    error: 0,
    skipped: 0,
    candidates: 0,
    bySeverity: {},
    byVerdict: {},
    byTriage: { P0: 0, P1: 0, P2: 0, skip: 0 },
  };
}

const triageTotals = { P0: 0, P1: 0, P2: 0, skip: 0 };

const rows = [];

for (const fp of walk(filesRoot)) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  const rel = rec.filePath;
  const area = areaOf(rel);
  if (!stats[area]) continue;
  const st = rec.status ?? "?";
  if (st === "analyzed") stats[area].analyzed += 1;
  else if (st === "pending") stats[area].pending += 1;
  else if (st === "error") stats[area].error += 1;
  else stats[area].skipped += 1;
  stats[area].candidates += (rec.candidates ?? []).length;
  for (const f of rec.findings ?? []) {
    const sev = f.severity ?? "?";
    stats[area].bySeverity[sev] = (stats[area].bySeverity[sev] ?? 0) + 1;
    const v = f.revalidation?.verdict ?? "unrevalidated";
    stats[area].byVerdict[v] = (stats[area].byVerdict[v] ?? 0) + 1;
    const pr = f.triage?.priority;
    if (pr === "P0" || pr === "P1" || pr === "P2" || pr === "skip") {
      stats[area].byTriage[pr] += 1;
      triageTotals[pr] += 1;
    }
    const lines = (f.lineNumbers ?? []).join(",");
    rows.push({
      area,
      id: f.findingId ?? f.title,
      severity: sev,
      filePath: rel,
      lines,
      title: f.title,
      slug: f.vulnSlug,
      verdict: f.revalidation?.verdict ?? "unrevalidated",
      reasoning: (f.revalidation?.reasoning ?? "").slice(0, 120),
      triage: f.triage?.priority ?? "",
    });
  }
}

rows.sort((a, b) => {
  const sa = severityOrder.indexOf(a.severity);
  const sb = severityOrder.indexOf(b.severity);
  if (sa !== sb) return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb);
  if (a.verdict === "true-positive" && b.verdict !== "true-positive") return -1;
  if (b.verdict === "true-positive" && a.verdict !== "true-positive") return 1;
  return a.filePath.localeCompare(b.filePath);
});

console.log(JSON.stringify({ stats, triageTotals, rows }, null, 2));

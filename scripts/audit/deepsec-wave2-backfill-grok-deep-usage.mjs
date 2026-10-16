#!/usr/bin/env node
/**
 * Repair Grok marker-2 rows where deepsec persisted parsed findings (findingCount > 0)
 * but Grok CLI reported usage.outputTokens === 0. Sets outputTokens from sealed finding
 * text only — never from duration, never deep_ok without parse evidence.
 */
import fs from "node:fs";
import {
  filesRootForRepo,
  grokDeepMaxTurns,
  grokShallowMaxTurns,
  isGrokDurationSyntheticUsage,
  walkJsonFiles,
} from "./deepsec-wave2-completion.mjs";

const repoRoot = process.argv[2] ?? process.cwd();
const marker = Number(process.argv[3] ?? "2");
const dryRun = process.argv.includes("--dry-run");
const revertSynthetic = process.argv.includes("--revert-synthetic");

const deep = grokDeepMaxTurns();
const shallow = grokShallowMaxTurns();

function findingsForRun(rec, runId) {
  return (rec.findings ?? []).filter((f) => f.producedByRunId === runId);
}

function estimateOutputTokensFromFindings(findings) {
  if (findings.length === 0) return 0;
  const text = JSON.stringify(findings);
  return Math.max(64, Math.ceil(text.length / 4));
}

let rows = 0;
let reverted = 0;
let filesWritten = 0;

for (const fp of walkJsonFiles(filesRootForRepo(repoRoot))) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  const hist = rec.analysisHistory ?? [];
  let changed = false;
  for (const h of hist) {
    if (h.reinvestigateMarker !== marker) continue;
    if (h.phase === "revalidate") continue;
    if (h.agentType !== "grok") continue;

    const stderr = String(h.codexStderr ?? "");
    const runId = h.runId;
    const findings = runId ? findingsForRun(rec, runId) : [];
    const parseProven = (h.findingCount ?? 0) > 0 && findings.length > 0;

    if (
      revertSynthetic &&
      isGrokDurationSyntheticUsage(h) &&
      stderr.includes("deep_ok") &&
      !parseProven
    ) {
      h.usage = {
        ...h.usage,
        outputTokens: 0,
      };
      h.codexStderr = "shallow_timeout:60";
      reverted += 1;
      changed = true;
      continue;
    }

    if (typeof h.numTurns !== "number" || h.numTurns < deep - 0.01) continue;
    if ((h.usage?.outputTokens ?? 0) > 0 && !isGrokDurationSyntheticUsage(h)) {
      continue;
    }
    if (!parseProven) continue;

    const out = estimateOutputTokensFromFindings(findings);
    if (out <= 0) continue;

    h.usage = {
      inputTokens: Math.max(1, h.usage?.inputTokens ?? 0),
      outputTokens: out,
      cacheReadInputTokens: h.usage?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: h.usage?.cacheCreationInputTokens ?? 0,
    };
    const shallowTag = stderr.includes("turn_cap") ? "turn_cap" : "timeout";
    h.codexStderr = `deep_ok;shallow_${shallowTag}:${shallow}`;
    rows += 1;
    changed = true;
  }
  if (changed && !dryRun) {
    fs.writeFileSync(fp, `${JSON.stringify(rec, null, 2)}\n`);
    filesWritten += 1;
  }
}

process.stdout.write(
  `${JSON.stringify({
    dryRun,
    marker,
    rowsRepaired: rows,
    rowsReverted: reverted,
    filesWritten,
  })}\n`,
);

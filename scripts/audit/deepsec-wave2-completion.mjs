#!/usr/bin/env node
/**
 * Wave-2 completion rule — matches deepsec `process --reinvestigate N` selection
 * (marker N + agentType + outputTokens > 0).
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MARKER = 2;
export const DEFAULT_AGENT = "kimi";
/** Wave-2 gate: marker N complete on any of these agents (Kimi or Grok per operator order). */
export const WAVE2_INVESTIGATE_AGENTS = ["kimi", "grok"];

export function filesRootForRepo(repoRoot) {
  return path.join(repoRoot, ".deepsec", "data", "opensesame", "files");
}

export function walkJsonFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJsonFiles(p));
    else if (ent.name.endsWith(".json")) out.push(p);
  }
  return out;
}

export function grokShallowMaxTurns() {
  const n = Number(
    process.env.DEEPSEC_GROK_SHALLOW_MAX_TURNS ??
      process.env.DEEPSEC_GROK_MAX_TURNS ??
      "60",
  );
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

export function grokDeepMaxTurns() {
  const n = Number(process.env.DEEPSEC_GROK_DEEP_MAX_TURNS ?? "150");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 150;
}

/** True when outputTokens match the duration/1000 backfill heuristic (not Grok CLI usage). */
export function isGrokDurationSyntheticUsage(row) {
  if (typeof row !== "object" || row === null) return false;
  const out = row.usage?.outputTokens ?? 0;
  const dur = row.durationMs ?? 0;
  if (out <= 0 || dur <= 0) return false;
  return out === Math.ceil(dur / 1000);
}

/**
 * Grok marker-2 row with evidence the headless investigate JSON was parsed and applied.
 * Shallow-only success is shallow_ok. Deep retry success is deep_ok with findingCount > 0
 * (deepsec only increments findingCount for new findings persisted from that run).
 * numTurns alone is not evidence.
 */
function hasRealGrokOutput(row) {
  const out = row.usage?.outputTokens ?? 0;
  return out > 0 && !isGrokDurationSyntheticUsage(row);
}

function isShallowLimitStderr(stderr) {
  return (
    stderr.includes("shallow_timeout") ||
    stderr.includes("shallow_turn_cap") ||
    /max turns/i.test(stderr)
  );
}

export function isGrokMarker2InvestigationFinished(row) {
  if (typeof row !== "object" || row === null) return false;
  if (row.agentType !== "grok") return true;
  const stderr = String(row.codexStderr ?? "");
  if (stderr.includes("shallow_ok")) return true;
  // deepsec sets findingCount only after a parsed investigate result is applied
  if ((row.findingCount ?? 0) > 0) return true;
  if (stderr.includes("deep_ok")) return hasRealGrokOutput(row);
  return hasRealGrokOutput(row) && !isShallowLimitStderr(stderr);
}

/** outputTokens > 0 that count toward the gate (reject duration-only synthetic unless parse-proven). */
export function isGrokWave2UsageCreditable(row) {
  if (typeof row !== "object" || row === null) return false;
  const out = row.usage?.outputTokens ?? 0;
  if (out <= 0) return false;
  if (!isGrokDurationSyntheticUsage(row)) return true;
  return isGrokMarker2InvestigationFinished(row) && (row.findingCount ?? 0) > 0;
}

/** Grok marker-N row that hit shallow cap/timeout — not wave-2 complete until deep pass. */
export function isGrokShallowIncomplete(h) {
  if (typeof h !== "object" || h === null) return false;
  const row = h;
  if (row.agentType !== "grok") return false;
  if (isGrokMarker2InvestigationFinished(row)) return false;
  const shallow = grokShallowMaxTurns();
  const configured = row.modelConfig?.maxTurns;
  const stderr = String(row.codexStderr ?? "");
  if (stderr.includes("shallow_ok")) return false;
  if (stderr.includes("deep_ok")) return false;
  if (
    stderr.includes("shallow_turn_cap") ||
    stderr.includes("shallow_timeout")
  ) {
    return true;
  }
  if (typeof row.numTurns === "number" && row.numTurns >= shallow - 0.01) {
    if (configured === shallow) return true;
  }
  if (/max turns/i.test(stderr)) return true;
  return false;
}

/** @param {unknown} h */
export function isWaveProcessComplete(h, marker, agentType) {
  if (typeof h !== "object" || h === null) return false;
  const row = h;
  if (row.reinvestigateMarker !== marker) return false;
  if (row.phase === "revalidate") return false;
  if (row.agentType !== agentType) return false;
  if ((row.usage?.outputTokens ?? 0) <= 0) return false;
  if (agentType === "grok") {
    if (isGrokShallowIncomplete(row)) return false;
    if (!isGrokMarker2InvestigationFinished(row)) return false;
    if (!isGrokWave2UsageCreditable(row)) return false;
  }
  return true;
}

export function countWaveCompletion(
  repoRoot,
  marker = DEFAULT_MARKER,
  agentType = DEFAULT_AGENT,
) {
  const agentTypes =
    agentType === "wave2" ? WAVE2_INVESTIGATE_AGENTS : [agentType];
  const filesRoot = filesRootForRepo(repoRoot);
  const paths = walkJsonFiles(filesRoot);
  let complete = 0;
  for (const fp of paths) {
    const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
    const hist = rec.analysisHistory ?? [];
    if (
      agentTypes.some((at) =>
        hist.some((h) => isWaveProcessComplete(h, marker, at)),
      )
    ) {
      complete += 1;
    }
  }
  return {
    marker,
    agentType: agentType === "wave2" ? "kimi|grok" : agentType,
    filesComplete: complete,
    filesTracked: paths.length,
  };
}

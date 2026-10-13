#!/usr/bin/env node
/**
 * Run deepsec-style triage via the Grok Build agent plugin.
 * deepsec 2.3.6 `triage` is hardcoded to Claude Agent SDK; this script mirrors
 * processor/triage.ts and calls `--agent grok` from our plugin instead.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.argv.includes("--root")
  ? process.argv[process.argv.indexOf("--root") + 1]
  : path.resolve(import.meta.dirname, "../..");
const projectId = "opensesame";
const ws = path.join(repoRoot, ".deepsec");
const dataDir = path.join(ws, "data", projectId);
const filesDir = path.join(dataDir, "files");
const agentKind = process.env.DEEPSEC_AGENT ?? "kimi";
const model =
  process.env.DEEPSEC_GROK_MODEL ??
  (agentKind === "kimi" ? "kimi-code/k3" : "grok-4.7");
const force = process.argv.includes("--force");
const severityArg = process.argv.find((a) => a.startsWith("--severity="));
const severities = severityArg
  ? [severityArg.split("=")[1]]
  : process.argv.includes("--all-severities")
    ? ["CRITICAL", "HIGH", "MEDIUM", "HIGH_BUG", "BUG", "LOW"]
    : ["MEDIUM"];

const BATCH_SIZE = 10;
const concurrency = Number(
  process.env.DEEPSEC_CONCURRENCY ?? Math.max(1, os.cpus().length - 1),
);

process.env.XAI_API_KEY = undefined;
process.env.GROK_DEPLOYMENT_KEY = undefined;
process.env.MOONSHOT_API_KEY = undefined;

function resolveJitiEntry() {
  const pnpm = path.join(ws, "node_modules/.pnpm");
  const dir = fs.readdirSync(pnpm).find((d) => d.startsWith("jiti@"));
  if (!dir)
    throw new Error(
      "jiti not found under .deepsec (run pnpm install in .deepsec)",
    );
  return path.join(pnpm, dir, "node_modules/jiti/lib/jiti.mjs");
}
const jitiPkg = resolveJitiEntry();
const { createJiti } = await import(pathToFileURL(jitiPkg).href);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const pluginPath =
  agentKind === "kimi"
    ? path.join(ws, "kimi-agent-plugin.ts")
    : path.join(ws, "grok-agent-plugin.ts");
const pluginModule = await jiti.import(pluginPath);
const agentPlugin =
  agentKind === "kimi"
    ? pluginModule.kimiAgentPlugin
    : pluginModule.grokAgentPlugin;
const agent = agentPlugin.agents[0];

let projectInfo = "";
try {
  projectInfo = fs.readFileSync(path.join(dataDir, "INFO.md"), "utf8");
} catch {
  // optional
}

const projectRoot = path.resolve(repoRoot);

function walkJson(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJson(p));
    else if (ent.name.endsWith(".json")) out.push(p);
  }
  return out;
}

function loadRecords() {
  const byPath = new Map();
  for (const fp of walkJson(filesDir)) {
    const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
    byPath.set(rec.filePath, { record: rec, path: fp });
  }
  return byPath;
}

async function runAgentTriage(batch) {
  const refs = batch.map(({ record, finding }) => ({
    filePath: record.filePath,
    title: finding.title,
    severity: finding.severity,
    vulnSlug: finding.vulnSlug,
    lineNumbers: finding.lineNumbers ?? [],
    confidence: finding.confidence ?? "medium",
    description: finding.description,
  }));
  const gen = agent.triage({
    batch: refs,
    projectRoot,
    projectInfo,
    config: { model },
  });
  let result;
  while (true) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    const ev = step.value;
    if (ev.type === "started" || ev.type === "complete") {
      console.log(`  ${ev.message}`);
    } else if (ev.type === "error") {
      console.warn(`  ${ev.message}`);
    }
  }
  return result?.verdicts ?? [];
}

async function triageBatch(batch, batchIdx, totalBatches) {
  console.log(
    `Batch ${batchIdx + 1}/${totalBatches} (${batch.length} findings)`,
  );
  let verdicts = [];
  try {
    verdicts = await runAgentTriage(batch);
  } catch (err) {
    console.warn(
      `  Batch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
  let matched = 0;
  for (const verdict of verdicts) {
    const item = batch.find((b) => b.finding.title === verdict.title);
    if (!item) continue;
    item.finding.triage = {
      priority: verdict.priority,
      exploitability: verdict.exploitability,
      impact: verdict.impact,
      reasoning: verdict.reasoning,
      triagedAt: new Date().toISOString(),
      model,
    };
    matched += 1;
  }
  const dirty = new Set(batch.map((b) => b.path));
  for (const p of dirty) {
    const rec = batch.find((b) => b.path === p)?.record;
    if (rec) fs.writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`);
  }
  return matched;
}

async function runSeverity(severity) {
  const byPath = loadRecords();
  const toTriage = [];
  for (const { record, path: filePath } of byPath.values()) {
    for (const finding of record.findings ?? []) {
      if (finding.severity !== severity) continue;
      if (!force && finding.triage) continue;
      toTriage.push({ record, finding, path: filePath });
    }
  }
  if (toTriage.length === 0) {
    console.log(`No ${severity} findings to triage`);
    return { triaged: 0, p0: 0, p1: 0, p2: 0, skip: 0 };
  }
  console.log(
    `Triaging ${toTriage.length} ${severity} finding(s) with ${agentKind} (${model})`,
  );
  const batches = [];
  for (let i = 0; i < toTriage.length; i += BATCH_SIZE) {
    batches.push(toTriage.slice(i, i + BATCH_SIZE));
  }
  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  let skip = 0;
  let totalTriaged = 0;
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const idx = next++;
      const n = await triageBatch(batches[idx], idx, batches.length);
      totalTriaged += n;
      for (const item of batches[idx]) {
        const pr = item.finding.triage?.priority;
        if (pr === "P0") p0 += 1;
        else if (pr === "P1") p1 += 1;
        else if (pr === "P2") p2 += 1;
        else if (pr === "skip") skip += 1;
      }
    }
  }
  const workers = Math.min(concurrency, batches.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  console.log(
    `Triage ${severity}: ${totalTriaged} — P0:${p0} P1:${p1} P2:${p2} skip:${skip}`,
  );
  return { triaged: totalTriaged, p0, p1, p2, skip };
}

const totals = { triaged: 0, p0: 0, p1: 0, p2: 0, skip: 0 };
for (const sev of severities) {
  const r = await runSeverity(sev);
  totals.triaged += r.triaged;
  totals.p0 += r.p0;
  totals.p1 += r.p1;
  totals.p2 += r.p2;
  totals.skip += r.skip;
}
console.log(
  `Triage complete: ${totals.triaged} — P0:${totals.p0} P1:${totals.p1} P2:${totals.p2} skip:${totals.skip}`,
);

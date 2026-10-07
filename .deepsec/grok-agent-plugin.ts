/**
 * deepsec agent backend: Grok Build CLI (subscription), headless via `grok -p`.
 * deepsec 2.3.6 has no native grok agent; this plugin registers `--agent grok`.
 *
 * Auth: `unset XAI_API_KEY` then `grok login --device-auth` (subscription).
 * Do not rely on XAI_API_KEY unless explicitly approved (per-token billing).
 */
import { spawn } from "node:child_process";
import type { DeepsecPlugin } from "deepsec/config";

const GROK_SYSTEM_NOTE =
  "You are running inside the deepsec harness for OpenSesame. Use read-only inspection (read/grep files). " +
  "Do not run the target application, send network requests, or attempt exploitation.";

const JSON_ONLY_SUFFIX =
  "\n\n## CRITICAL — output format\n" +
  "Your **entire** final reply must be **only** a JSON array (you may wrap it in a ```json fence). " +
  "Do **not** write prose before or after the JSON. Do **not** write \"I'll review\", summaries, or markdown outside the fence. " +
  "The first non-whitespace character must be `[` or a backtick starting a json code fence.";

const DEFAULT_MODEL = "grok-4.7";
const MAX_ATTEMPTS = 3;

type FileRecord = {
  filePath: string;
  candidates: Array<{
    vulnSlug: string;
    lineNumbers: number[];
    matchedPattern: string;
  }>;
  findings?: Finding[];
};

type Finding = {
  findingId?: string;
  severity: string;
  vulnSlug: string;
  title: string;
  description: string;
  lineNumbers: number[];
  recommendation: string;
  confidence: string;
};

type InvestigateParams = {
  batch: FileRecord[];
  projectRoot: string;
  promptTemplate: string;
  projectInfo: string;
  config: Record<string, unknown>;
  signal?: AbortSignal;
  projectId?: string;
};

type RevalidateParams = {
  batch: FileRecord[];
  projectRoot: string;
  projectInfo: string;
  config: Record<string, unknown>;
  force?: boolean;
  onlyFindingIds?: string[];
  signal?: AbortSignal;
  projectId?: string;
};

function modelFromConfig(config: Record<string, unknown>): string {
  const m = config.model;
  return typeof m === "string" && m.length > 0 ? m : DEFAULT_MODEL;
}

function grokEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.XAI_API_KEY;
  delete env.GROK_DEPLOYMENT_KEY;
  return env;
}

function extractTextFromGrokStdout(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n").filter((l) => l.trim());
  const texts: string[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === "error" && typeof obj.message === "string") {
        throw new Error(obj.message);
      }
      if (typeof obj.result === "string") texts.push(obj.result);
      if (typeof obj.text === "string") texts.push(obj.text);
      if (typeof obj.message === "string" && obj.type !== "error") texts.push(obj.message);
      const content = obj.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && typeof (block as { text?: string }).text === "string") {
            texts.push((block as { text: string }).text);
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("Not signed in")) throw e;
      // not JSON line — keep as plain text fallback
    }
  }
  if (texts.length > 0) return texts.join("\n");
  try {
    const whole = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof whole.result === "string") return whole.result;
    if (typeof whole.text === "string") return whole.text;
  } catch {
    // fall through
  }
  return trimmed;
}

function runGrokPrompt(params: {
  cwd: string;
  prompt: string;
  model: string;
  signal?: AbortSignal;
  maxTurns?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(params.signal.reason ?? new Error("aborted"));
      return;
    }
    const args = [
      "-p",
      params.prompt,
      "-m",
      params.model,
      "--always-approve",
      "--output-format",
      "json",
      "--max-turns",
      String(params.maxTurns ?? 150),
    ];
    const child = spawn("grok", args, {
      cwd: params.cwd,
      env: grokEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new Error("aborted"));
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      params.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      params.signal?.removeEventListener("abort", onAbort);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `grok exited ${code}`));
        return;
      }
      try {
        resolve(extractTextFromGrokStdout(stdout + (stderr.includes("Not signed in") ? `\n${stderr}` : "")));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseJsonArrayFromAgent(text: string): unknown[] {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = fence ? fence[1].trim() : text.trim();
  const parsed = JSON.parse(jsonStr) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array from agent");
  }
  return parsed;
}

function parseInvestigateResults(resultText: string, batch: FileRecord[]) {
  const parsed = parseJsonArrayFromAgent(resultText) as Array<{
    filePath: string;
    findings?: Finding[];
  }>;
  const batchPaths = new Set(batch.map((r) => r.filePath));
  const results: Array<{ filePath: string; findings: Finding[] }> = [];
  for (const entry of parsed) {
    if (!batchPaths.has(entry.filePath)) continue;
    results.push({ filePath: entry.filePath, findings: entry.findings ?? [] });
    batchPaths.delete(entry.filePath);
  }
  for (const filePath of batchPaths) {
    results.push({ filePath, findings: [] });
  }
  return { results, invalid: [] as unknown[] };
}

function buildRevalidatePrompt(batch: FileRecord[], projectInfo: string): { prompt: string; total: number } {
  const sections: string[] = [];
  let total = 0;
  for (const file of batch) {
    const findings = file.findings ?? [];
    if (findings.length === 0) continue;
    total += findings.length;
    const list = findings
      .map(
        (f, i) =>
          `### Finding F${i + 1}: ${f.title}\n- **Finding ID:** F${i + 1}\n- **Severity:** ${f.severity}\n- **Slug:** ${f.vulnSlug}\n- **Lines:** ${f.lineNumbers.join(", ")}\n- **Description:** ${f.description}\n- **Recommendation:** ${f.recommendation}`,
      )
      .join("\n\n");
    sections.push(`## File: ${file.filePath}\n\n${list}`);
  }
  const ctx = projectInfo ? `## Project Context\n\n${projectInfo}\n\n` : "";
  const prompt = `You are a security researcher revalidating vulnerability findings (static analysis only).

${ctx}${sections.join("\n---\n\n")}

For each finding ID (F1, F2, …), output a verdict JSON array:

\`\`\`json
[
  { "findingId": "F1", "verdict": "true-positive|false-positive|fixed|uncertain|duplicate", "reasoning": "...", "adjustedSeverity": "HIGH" }
]
\`\`\`${JSON_ONLY_SUFFIX}`;
  return { prompt, total };
}

function parseRevalidateVerdicts(text: string) {
  return parseJsonArrayFromAgent(text) as Array<{
    findingId: string;
    verdict: string;
    reasoning: string;
    adjustedSeverity?: string;
    duplicateOf?: string;
  }>;
}

class GrokAgentPlugin {
  type = "grok";

  async *investigate(params: InvestigateParams) {
    const model = modelFromConfig(params.config);
    const fileList = params.batch
      .map((r) => {
        if (r.candidates.length === 0) return `- **${r.filePath}** (holistic review)`;
        const details = r.candidates
          .map((m) => `    - [${m.vulnSlug}] L${m.lineNumbers.join(", ")}: ${m.matchedPattern}`)
          .join("\n");
        return `- **${r.filePath}**\n${details}`;
      })
      .join("\n");
    const projectInfoBlock = params.projectInfo ? `## Project Context\n\n${params.projectInfo}\n\n` : "";
    const prompt = `${GROK_SYSTEM_NOTE}\n\n${params.promptTemplate}\n\n${projectInfoBlock}## Target Files\n\n${fileList}\n\nInvestigate each file; output JSON array per deepsec schema.${JSON_ONLY_SUFFIX}`;
    const start = Date.now();
    yield { type: "started", message: `Investigating ${params.batch.length} file(s) with Grok Build (${model})` };
    let resultText = "";
    let lastError = "";
    let lastParse = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const body =
        attempt === 1
          ? prompt
          : `${prompt}\n\nYour previous reply was rejected: ${lastParse}. Output ONLY the JSON array now. No other text.`;
      try {
        resultText = await runGrokPrompt({
          cwd: params.projectRoot,
          prompt: body,
          model,
          signal: params.signal,
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        resultText = "";
        yield { type: "error", message: `Grok error: ${lastError.slice(0, 300)}` };
        continue;
      }
      if (!resultText) continue;
      try {
        parseInvestigateResults(resultText, params.batch);
        break;
      } catch (e) {
        lastParse = e instanceof Error ? e.message : String(e);
        resultText = "";
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(`Grok investigation JSON parse failed: ${lastParse}`);
        }
      }
    }
    if (!resultText) {
      throw new Error(
        `Grok produced no investigation result. Last error: ${lastError || lastParse || "(none)"}`,
      );
    }
    const parsed = parseInvestigateResults(resultText, params.batch);
    yield {
      type: "complete",
      message: `Investigation complete (${((Date.now() - start) / 1000).toFixed(1)}s)`,
    };
    return {
      results: parsed.results,
      meta: {
        durationMs: Date.now() - start,
        agentType: this.type,
        model,
      },
    };
  }

  async *revalidate(params: RevalidateParams) {
    const model = modelFromConfig(params.config);
    const { prompt, total } = buildRevalidatePrompt(params.batch, params.projectInfo);
    const start = Date.now();
    yield {
      type: "started",
      message: `Revalidating ${total} finding(s) with Grok Build (${model})`,
    };
    let resultText = "";
    let lastParse = "";
    const fullPrompt = `${GROK_SYSTEM_NOTE}\n\n${prompt}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const body =
        attempt === 1
          ? fullPrompt
          : `${fullPrompt}\n\nYour previous reply was rejected: ${lastParse}. Output ONLY the JSON array now. No other text.`;
      resultText = await runGrokPrompt({
        cwd: params.projectRoot,
        prompt: body,
        model,
        signal: params.signal,
      });
      try {
        parseRevalidateVerdicts(resultText);
        break;
      } catch (e) {
        lastParse = e instanceof Error ? e.message : String(e);
        resultText = "";
        if (attempt >= MAX_ATTEMPTS) throw new Error(`Grok revalidation JSON parse failed: ${lastParse}`);
      }
    }
    const verdicts = parseRevalidateVerdicts(resultText);
    yield {
      type: "complete",
      message: `Revalidation complete (${((Date.now() - start) / 1000).toFixed(1)}s, ${verdicts.length} verdicts)`,
    };
    return {
      verdicts,
      meta: { durationMs: Date.now() - start, model },
      rawResponses: [{ kind: "initial", rawText: resultText, parsedCount: verdicts.length }],
      repairAttempts: 0,
    };
  }
}

export const grokAgentPlugin: DeepsecPlugin = {
  name: "opensesame-grok-build",
  agents: [new GrokAgentPlugin()],
};

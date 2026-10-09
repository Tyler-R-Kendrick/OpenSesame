/**
 * Shared deepsec headless agent (investigate / revalidate / triage) for external CLIs.
 */

import {
  buildRevalidatePrompt,
  buildTriagePrompt,
  parseInvestigateResults,
  parseRevalidateVerdicts,
  parseTriageVerdicts,
} from "./deepsec-headless-agent-prompts.js";
import {
  DEEPSEC_SYSTEM_NOTE,
  type InvestigateParams,
  JSON_ONLY_SUFFIX,
  MAX_ATTEMPTS,
  type RevalidateParams,
  type RunPromptParams,
  type TriageParams,
} from "./deepsec-headless-agent-types.js";

export {
  DEEPSEC_SYSTEM_NOTE,
  DEFAULT_GROK_MODEL,
  DEFAULT_KIMI_MODEL,
  JSON_ONLY_SUFFIX,
  MAX_ATTEMPTS,
} from "./deepsec-headless-agent-types.js";
export type {
  FileRecord,
  Finding,
  InvestigateParams,
  RevalidateParams,
  RunPromptParams,
  TriageFindingRef,
  TriageParams,
  TriageVerdict,
} from "./deepsec-headless-agent-types.js";

export function modelFromConfig(
  config: Record<string, unknown>,
  defaultModel: string,
): string {
  const m = config.model;
  return typeof m === "string" && m.length > 0 ? m : defaultModel;
}

export function extractTextFromAgentStdout(
  stdout: string,
  authHint?: string,
): string {
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
      if (typeof obj.message === "string" && obj.type !== "error")
        texts.push(obj.message);
      const content = obj.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            typeof (block as { text?: string }).text === "string"
          ) {
            texts.push((block as { text: string }).text);
          }
        }
      }
    } catch (e) {
      if (authHint && e instanceof Error && e.message.includes(authHint))
        throw e;
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

export function createHeadlessDeepsecAgent(options: {
  type: string;
  providerLabel: string;
  defaultModel: string;
  runPrompt: (params: RunPromptParams) => Promise<string>;
}) {
  const { type, providerLabel, runPrompt, defaultModel } = options;

  return class HeadlessDeepsecAgent {
    type = type;

    async *investigate(params: InvestigateParams) {
      const model = modelFromConfig(params.config, defaultModel);
      const fileList = params.batch
        .map((r) => {
          if (r.candidates.length === 0)
            return `- **${r.filePath}** (holistic review)`;
          const details = r.candidates
            .map(
              (m) =>
                `    - [${m.vulnSlug}] L${m.lineNumbers.join(", ")}: ${m.matchedPattern}`,
            )
            .join("\n");
          return `- **${r.filePath}**\n${details}`;
        })
        .join("\n");
      const projectInfoBlock = params.projectInfo
        ? `## Project Context\n\n${params.projectInfo}\n\n`
        : "";
      const prompt = `${DEEPSEC_SYSTEM_NOTE}\n\n${params.promptTemplate}\n\n${projectInfoBlock}## Target Files\n\n${fileList}\n\nInvestigate each file; output JSON array per deepsec schema.${JSON_ONLY_SUFFIX}`;
      const start = Date.now();
      yield {
        type: "started",
        message: `Investigating ${params.batch.length} file(s) with ${providerLabel} (${model})`,
      };
      let resultText = "";
      let lastError = "";
      let lastParse = "";
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const body =
          attempt === 1
            ? prompt
            : `${prompt}\n\nYour previous reply was rejected: ${lastParse}. Output ONLY the JSON array now. No other text.`;
        try {
          resultText = await runPrompt({
            cwd: params.projectRoot,
            prompt: body,
            model,
            signal: params.signal,
          });
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          resultText = "";
          yield {
            type: "error",
            message: `${providerLabel} error: ${lastError.slice(0, 300)}`,
          };
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
            throw new Error(
              `${providerLabel} investigation JSON parse failed: ${lastParse}`,
            );
          }
        }
      }
      if (!resultText) {
        throw new Error(
          `${providerLabel} produced no investigation result. Last error: ${lastError || lastParse || "(none)"}`,
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
      const model = modelFromConfig(params.config, defaultModel);
      const { prompt, total } = buildRevalidatePrompt(
        params.batch,
        params.projectInfo,
      );
      const start = Date.now();
      yield {
        type: "started",
        message: `Revalidating ${total} finding(s) with ${providerLabel} (${model})`,
      };
      let resultText = "";
      let lastParse = "";
      const fullPrompt = `${DEEPSEC_SYSTEM_NOTE}\n\n${prompt}`;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const body =
          attempt === 1
            ? fullPrompt
            : `${fullPrompt}\n\nYour previous reply was rejected: ${lastParse}. Output ONLY the JSON array now. No other text.`;
        resultText = await runPrompt({
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
          if (attempt >= MAX_ATTEMPTS) {
            throw new Error(
              `${providerLabel} revalidation JSON parse failed: ${lastParse}`,
            );
          }
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
        rawResponses: [
          {
            kind: "initial",
            rawText: resultText,
            parsedCount: verdicts.length,
          },
        ],
        repairAttempts: 0,
      };
    }

    async *triage(params: TriageParams) {
      const model = modelFromConfig(params.config, defaultModel);
      const prompt = buildTriagePrompt(params.batch, params.projectInfo);
      const start = Date.now();
      yield {
        type: "started",
        message: `Triaging ${params.batch.length} finding(s) with ${providerLabel} (${model})`,
      };
      let resultText = "";
      let lastParse = "";
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const body =
          attempt === 1
            ? prompt
            : `${prompt}\n\nYour previous reply was rejected: ${lastParse}. Output ONLY the JSON array now. No other text.`;
        resultText = await runPrompt({
          cwd: params.projectRoot,
          prompt: body,
          model,
          signal: params.signal,
          maxTurns: 1,
        });
        try {
          parseTriageVerdicts(resultText);
          break;
        } catch (e) {
          lastParse = e instanceof Error ? e.message : String(e);
          resultText = "";
          if (attempt >= MAX_ATTEMPTS) {
            throw new Error(
              `${providerLabel} triage JSON parse failed: ${lastParse}`,
            );
          }
        }
      }
      const verdicts = parseTriageVerdicts(resultText);
      yield {
        type: "complete",
        message: `Triage complete (${((Date.now() - start) / 1000).toFixed(1)}s, ${verdicts.length} verdicts)`,
      };
      return {
        verdicts,
        meta: { durationMs: Date.now() - start, model },
      };
    }
  };
}

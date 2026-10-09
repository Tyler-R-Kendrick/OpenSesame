import { parseInvestigateResults } from "./deepsec-headless-agent-prompts.js";
import {
  DEEPSEC_SYSTEM_NOTE,
  type InvestigateParams,
  JSON_ONLY_SUFFIX,
  MAX_ATTEMPTS,
  type RunPromptParams,
  modelFromConfig,
} from "./deepsec-headless-agent-types.js";

function formatInvestigateFileList(batch: InvestigateParams["batch"]): string {
  return batch
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
}

export async function* runHeadlessInvestigate(
  params: InvestigateParams,
  options: {
    type: string;
    providerLabel: string;
    defaultModel: string;
    runPrompt: (params: RunPromptParams) => Promise<string>;
  },
) {
  const { providerLabel, runPrompt, defaultModel } = options;
  const model = modelFromConfig(params.config, defaultModel);
  const projectInfoBlock = params.projectInfo
    ? `## Project Context\n\n${params.projectInfo}\n\n`
    : "";
  const prompt = `${DEEPSEC_SYSTEM_NOTE}\n\n${params.promptTemplate}\n\n${projectInfoBlock}## Target Files\n\n${formatInvestigateFileList(params.batch)}\n\nInvestigate each file; output JSON array per deepsec schema.${JSON_ONLY_SUFFIX}`;
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
      agentType: options.type,
      model,
    },
  };
}

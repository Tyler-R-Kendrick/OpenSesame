import {
  buildTriagePrompt,
  parseTriageVerdicts,
} from "./deepsec-headless-agent-prompts.js";
import {
  MAX_ATTEMPTS,
  type RunPromptParams,
  type TriageParams,
  modelFromConfig,
} from "./deepsec-headless-agent-types.js";

export async function* runHeadlessTriage(
  params: TriageParams,
  options: {
    providerLabel: string;
    defaultModel: string;
    runPrompt: (params: RunPromptParams) => Promise<string>;
  },
) {
  const { providerLabel, runPrompt, defaultModel } = options;
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

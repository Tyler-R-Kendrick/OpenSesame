import {
  buildRevalidatePrompt,
  parseRevalidateVerdicts,
} from "./deepsec-headless-agent-prompts.js";
import {
  DEEPSEC_SYSTEM_NOTE,
  MAX_ATTEMPTS,
  modelFromConfig,
  type RevalidateParams,
  type RunPromptParams,
} from "./deepsec-headless-agent-types.js";

export async function* runHeadlessRevalidate(
  params: RevalidateParams,
  options: {
    providerLabel: string;
    defaultModel: string;
    runPrompt: (params: RunPromptParams) => Promise<string>;
  },
) {
  const { providerLabel, runPrompt, defaultModel } = options;
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

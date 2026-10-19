import type {
  HostedModelInput,
  HostedModelResult,
} from "../hosted-model-protocol.js";
import { inferBedrockAi } from "./bedrock-inference.js";
import { aiConnectionFetch, readAiJson } from "./http.js";
import { aiInferenceAnswer, aiInferenceRequest } from "./protocol.js";
import { inferReplicateAi } from "./replicate-inference.js";
import type { ReplicateInput, ReplicateRunOptions } from "./replicate-types.js";
import { readAiTextStream } from "./stream.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  type AiConnectionTransport,
} from "./types.js";
import { inferVertexAi } from "./vertex-inference.js";
import { vertexConnectionTarget } from "./vertex-target.js";

/** Both connection testing and active inference execute the actual chosen family. */
export async function inferAiConnection(
  draft: AiConnectionDraft,
  input: HostedModelInput,
  transport: AiConnectionTransport,
  check: () => void,
  onText?: (text: string) => void,
  predictionOptions: ReplicateRunOptions = {},
): Promise<HostedModelResult> {
  if (input.model !== draft.model)
    throw new AiConnectionError(
      "configuration",
      "Use the model saved with this connection.",
    );
  if (draft.family === "replicate_predictions")
    return inferReplicateAi(
      draft,
      input,
      transport,
      check,
      onText,
      predictionOptions,
    );
  if (draft.family === "bedrock_converse")
    return inferBedrockAi(
      { ...draft, family: "bedrock_converse" },
      input,
      transport,
      check,
      onText,
    );
  const vertex = vertexConnectionTarget(draft);
  if (vertex)
    return inferVertexAi({ ...draft, vertex }, input, transport, check, onText);
  const request = aiInferenceRequest(draft, input, onText !== undefined);
  const response = await aiConnectionFetch(
    draft,
    request.url,
    transport,
    check,
    request.body,
  );
  let streamed = "";
  const safe = (text: string) => {
    streamed += text;
    if (draft.apiKey && streamed.includes(draft.apiKey))
      throw new AiConnectionError(
        "response",
        "The AI service returned credential material.",
      );
    onText?.(text);
  };
  const answer = onText
    ? await readAiTextStream(
        response,
        draft.family,
        safe,
        check,
        transport.signal,
      )
    : aiInferenceAnswer(draft.family, await readAiJson(response, check));
  check();
  transport.assertCurrent();
  transport.signal.throwIfAborted();
  if (draft.apiKey && answer.includes(draft.apiKey))
    throw new AiConnectionError(
      "response",
      "The AI service returned credential material.",
    );
  return { providerId: draft.providerId, model: draft.model, answer };
}

export function probeAiConnection(
  draft: AiConnectionDraft,
  transport: AiConnectionTransport,
  check: () => void,
  predictionInput?: ReplicateInput,
  predictionOptions: ReplicateRunOptions = {},
) {
  if (draft.family === "replicate_predictions") {
    if (predictionInput === undefined)
      throw new AiConnectionError(
        "configuration",
        "Supply explicit model-specific prediction input to test or save this connection.",
      );
    return inferAiConnection(
      draft,
      {
        model: draft.model,
        messages: [{ role: "user", content: JSON.stringify(predictionInput) }],
      },
      transport,
      check,
      undefined,
      predictionOptions,
    );
  }
  if (predictionInput !== undefined)
    throw new AiConnectionError(
      "configuration",
      "Prediction input belongs only to the prediction protocol.",
    );
  return inferAiConnection(
    draft,
    {
      model: draft.model,
      maxOutputTokens: 16,
      messages: [{ role: "user", content: "Reply with OK." }],
    },
    transport,
    check,
  );
}

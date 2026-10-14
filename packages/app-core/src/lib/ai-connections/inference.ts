import type {
  HostedModelInput,
  HostedModelResult,
} from "../hosted-model-protocol.js";
import { aiConnectionFetch, readAiJson } from "./http.js";
import { aiInferenceAnswer, aiInferenceRequest } from "./protocol.js";
import { readAiTextStream } from "./stream.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  type AiConnectionTransport,
} from "./types.js";

/** Both connection testing and active inference execute the actual chosen family. */
export async function inferAiConnection(
  draft: AiConnectionDraft,
  input: HostedModelInput,
  transport: AiConnectionTransport,
  check: () => void,
  onText?: (text: string) => void,
): Promise<HostedModelResult> {
  if (input.model !== draft.model)
    throw new AiConnectionError(
      "configuration",
      "Use the model saved with this connection.",
    );
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
) {
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

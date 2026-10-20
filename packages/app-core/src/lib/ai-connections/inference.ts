import { z } from "zod";
import type {
  HostedModelInput,
  HostedModelResult,
} from "../hosted-model-protocol.js";
import { inferAssemblyAi } from "./assemblyai-inference.js";
import { inferBedrockAi } from "./bedrock-inference.js";
import {
  validateAiAssemblyConnection,
  validateAiDeepgramConnection,
} from "./configuration.js";
import { inferDeepgramAi } from "./deepgram-inference.js";
import { aiConnectionFetch, readAiJson } from "./http.js";
import { type AiAudioInput, validateAiAudio } from "./media.js";
import { aiInferenceAnswer, aiInferenceRequest } from "./protocol.js";
import { inferReplicateAi } from "./replicate-inference.js";
import type { ReplicateInput, ReplicateRunOptions } from "./replicate-types.js";
import { inferSpeechAi } from "./speech-inference.js";
import { validateAiSpeechConnection } from "./speech-target.js";
import { readAiTextStream } from "./stream.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  type AiConnectionTransport,
  isAiSpeechFamily,
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
  if (isAiSpeechFamily(draft.family))
    return inferTranscriptionAi(
      draft,
      input,
      transport,
      check,
      onText,
      predictionOptions,
    );
  if (input.media !== undefined)
    throw new AiConnectionError(
      "configuration",
      "Local audio belongs only to the transcription protocol.",
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

function inferTranscriptionAi(
  draft: AiConnectionDraft,
  input: HostedModelInput,
  transport: AiConnectionTransport,
  check: () => void,
  onText?: (text: string) => void,
  predictionOptions: ReplicateRunOptions = {},
): Promise<HostedModelResult> {
  if (onText)
    throw new AiConnectionError(
      "configuration",
      "Transcription returns a finite transcript, not a text stream.",
    );
  const { media, ...fields } = input;
  try {
    z.object({ model: z.literal(draft.model), messages: z.tuple([]) })
      .strict()
      .parse(fields);
  } catch {
    throw new AiConnectionError(
      "configuration",
      "Supply local audio without a prompt or text-generation parameters.",
    );
  }
  if (draft.family === "assemblyai_transcript")
    return inferAssemblyAi(
      validateAiAssemblyConnection(draft),
      validateAiAudio(media),
      transport,
      check,
      { signal: predictionOptions.signal },
    );
  if (draft.family === "deepgram_listen")
    return inferDeepgramAi(
      validateAiDeepgramConnection(draft),
      validateAiAudio(media),
      transport,
      check,
    );
  return inferSpeechAi(
    validateAiSpeechConnection(draft),
    validateAiAudio(media),
    transport,
    check,
  );
}

export function probeAiConnection(
  draft: AiConnectionDraft,
  transport: AiConnectionTransport,
  check: () => void,
  predictionInput?: ReplicateInput,
  predictionOptions: ReplicateRunOptions = {},
  audio?: AiAudioInput,
) {
  if (isAiSpeechFamily(draft.family)) {
    if (predictionInput !== undefined || audio === undefined)
      throw new AiConnectionError(
        "configuration",
        "Supply explicit local audio to test or save this transcription connection.",
      );
    return inferAiConnection(
      draft,
      { model: draft.model, messages: [], media: audio },
      transport,
      check,
      undefined,
      predictionOptions,
    );
  }
  if (audio !== undefined)
    throw new AiConnectionError(
      "configuration",
      "Local audio belongs only to the transcription protocol.",
    );
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

/** Snapshot transient audio before private vault hydration can yield to another caller. */
export function captureAiSpeechAudio(
  audio?: AiAudioInput,
): AiAudioInput | undefined {
  if (audio === undefined) return undefined;
  const valid = validateAiAudio(audio);
  return { ...valid, bytes: new Uint8Array(valid.bytes) };
}

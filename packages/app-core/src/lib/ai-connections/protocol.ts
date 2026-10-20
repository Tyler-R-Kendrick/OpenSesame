import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  type HostedModelInput,
  hostedModelAnswer,
  hostedModelRequest,
} from "../hosted-model-protocol.js";
import { azureConnectionHeaders, azureInferenceUrl } from "./azure-protocol.js";
import { aiConnectionBase } from "./configuration.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  type AiInferenceFamily,
  isAiSpeechFamily,
  textAiFamily,
} from "./types.js";

const FAMILY_PROVIDER = {
  openai_chat: "openai",
  openai_responses: "openai",
  anthropic_messages: "anthropic",
  gemini_generate_content: "gemini",
} as const;

/** Reuse the existing hosted protocol builders, changing only the saved target and stream mode. */
export function aiInferenceRequest(
  draft: AiConnectionDraft,
  input: HostedModelInput,
  stream = false,
) {
  const family = textAiFamily(draft.family);
  const base = aiConnectionBase(draft.baseUrl);
  const azure = azureInferenceUrl(draft, base);
  const provider =
    family === "openai_chat" && draft.tokenParameter === "max_tokens"
      ? "openrouter"
      : FAMILY_PROVIDER[family];
  const request = hostedModelRequest(provider, input);
  const relative =
    family === "openai_responses"
      ? "responses"
      : family === "openai_chat"
        ? "chat/completions"
        : family === "anthropic_messages"
          ? "messages"
          : `models/${input.model}:${stream ? "streamGenerateContent" : "generateContent"}`;
  const url = azure ?? new URL(relative, base);
  if (stream && family === "gemini_generate_content")
    url.searchParams.set("alt", "sse");
  const body =
    family === "openai_responses"
      ? {
          model: input.model,
          input: input.messages,
          max_output_tokens: input.maxOutputTokens ?? 1024,
          stream,
        }
      : family === "gemini_generate_content"
        ? request.body
        : { ...request.body, stream };
  return { url, body };
}

export function aiConnectionHeaders(draft: AiConnectionDraft): Headers {
  if (isAiSpeechFamily(draft.family))
    throw new AiConnectionError(
      "configuration",
      draft.family === "elevenlabs_scribe"
        ? "Scribe audio requires its finite multipart transcription adapter."
        : "Deepgram audio requires its finite raw-audio transcription adapter.",
    );
  if (draft.family === "replicate_predictions")
    throw new AiConnectionError(
      "configuration",
      "Replicate predictions require their finite JSON job adapter.",
    );
  if (draft.family === "bedrock_converse")
    throw new AiConnectionError(
      "configuration",
      "Bedrock credentials must be signed, never sent as an API key.",
    );
  const azure = azureConnectionHeaders(draft);
  if (azure) return azure;
  const headers = new Headers({ "content-type": "application/json" });
  if (draft.authentication === "api-key") {
    if (!draft.apiKey)
      throw new AiConnectionError(
        "authentication",
        "Unlock the vault containing this AI credential.",
      );
    const header =
      draft.family === "anthropic_messages"
        ? "x-api-key"
        : draft.family === "gemini_generate_content"
          ? "x-goog-api-key"
          : "authorization";
    headers.set(
      header,
      draft.family === "openai_chat" || draft.family === "openai_responses"
        ? `Bearer ${draft.apiKey}`
        : draft.apiKey,
    );
  }
  if (draft.family === "anthropic_messages") {
    headers.set("anthropic-version", "2023-06-01");
    headers.set("anthropic-dangerous-direct-browser-access", "true");
  }
  return headers;
}

export function aiInferenceAnswer(
  family: AiInferenceFamily,
  value: BoundaryValue,
): string {
  if (isAiSpeechFamily(family))
    throw new AiConnectionError(
      "configuration",
      "Read transcription through its finite audio adapter.",
    );
  if (family === "replicate_predictions")
    throw new AiConnectionError(
      "configuration",
      "Read the terminal prediction through its finite JSON job adapter.",
    );
  if (family === "bedrock_converse")
    throw new AiConnectionError(
      "configuration",
      "Read Bedrock Converse through its finite response adapter.",
    );
  if (family === "openai_responses") {
    const response = z
      .object({
        status: z.literal("completed"),
        output: z.array(
          z.object({
            type: z.string(),
            content: z
              .array(
                z.object({ type: z.string(), text: z.string().optional() }),
              )
              .optional(),
          }),
        ),
      })
      .parse(value);
    const answer = response.output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    if (!answer || answer.length > 32768)
      throw new AiConnectionError(
        "response",
        "The model did not return a valid text answer.",
      );
    return answer;
  }
  return hostedModelAnswer(FAMILY_PROVIDER[family], value);
}

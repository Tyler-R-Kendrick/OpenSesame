import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  type HostedModelInput,
  hostedModelAnswer,
  hostedModelRequest,
} from "../hosted-model-protocol.js";
import { aiConnectionBase } from "./configuration.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  type AiInferenceFamily,
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
  const provider =
    draft.family === "openai_chat" && draft.tokenParameter === "max_tokens"
      ? "openrouter"
      : FAMILY_PROVIDER[draft.family];
  const request = hostedModelRequest(provider, input);
  const relative =
    draft.family === "openai_responses"
      ? "responses"
      : draft.family === "openai_chat"
        ? "chat/completions"
        : draft.family === "anthropic_messages"
          ? "messages"
          : `models/${input.model}:${stream ? "streamGenerateContent" : "generateContent"}`;
  const url = new URL(relative, aiConnectionBase(draft.baseUrl));
  if (stream && draft.family === "gemini_generate_content")
    url.searchParams.set("alt", "sse");
  const body =
    draft.family === "openai_responses"
      ? {
          model: input.model,
          input: input.messages,
          max_output_tokens: input.maxOutputTokens ?? 1024,
          stream,
        }
      : draft.family === "gemini_generate_content"
        ? request.body
        : { ...request.body, stream };
  return { url, body };
}

export function aiConnectionHeaders(draft: AiConnectionDraft): Headers {
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

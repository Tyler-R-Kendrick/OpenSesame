/**
 * AI SDK LanguageModelV2 over the browser Prompt API (`LanguageModel`).
 * Secrets never enter this path — only command schemas and item *names*.
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
} from "@ai-sdk/provider";
import {
  type LocalLanguageModelApi,
  type LocalModelSession,
  detectLocalLanguageModel,
} from "../../tutorial/agents/prompt-api/detect.js";

function promptText(options: LanguageModelV2CallOptions): string {
  const parts: string[] = [];
  for (const message of options.prompt) {
    if (message.role === "system") {
      parts.push(`System: ${message.content}`);
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") parts.push(part.text);
      }
    }
  }
  return parts.join("\n\n");
}

export function createPromptLanguageModel(options?: {
  api?: LocalLanguageModelApi | null;
  session?: LocalModelSession | null;
}): LanguageModelV2 {
  const api =
    options?.api === undefined ? detectLocalLanguageModel() : options.api;
  let session = options?.session ?? null;

  return {
    specificationVersion: "v2",
    provider: "opensesame.prompt-api",
    modelId: "browser-language-model",
    supportedUrls: {},
    async doGenerate(call) {
      if (api === null) {
        throw new Error("Browser language model is not available.");
      }
      const availability = await api.availability();
      if (availability !== "available") {
        throw new Error(
          availability === "downloadable"
            ? "Download the on-device model first (support panel)."
            : "Browser language model is not ready.",
        );
      }
      if (session === null) {
        session = await api.create({
          initialPrompts: [
            {
              role: "system",
              content:
                "You map short operator requests to a single JSON command. Never invent secrets. Reply with JSON only.",
            },
          ],
          signal: call.abortSignal ?? null,
          monitor: null,
        });
      }
      const text = await session.prompt(promptText(call), {
        signal: call.abortSignal ?? new AbortController().signal,
      });
      const content: LanguageModelV2Content[] = [{ type: "text", text }];
      return {
        content,
        finishReason: "stop" as const,
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("Streaming is not supported for the browser Prompt API.");
    },
  };
}

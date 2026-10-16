import type { BoundaryValue } from "@opensesame/os-domain";
import { vi } from "vitest";
import { modelApiOf } from "../ai-model-provider.js";
import type { HostedModelOperation } from "../hosted-model-authority.js";
import { runtimeFixture } from "../secret-backends/runtime.test-support.js";
import { aiConnectionDraft } from "./presets.js";
import { saveAiConnection } from "./runtime.js";
import { bindAiConnectionTransport } from "./transport.js";
import type { AiConnectionTransport } from "./types.js";

export type CanonicalAiProvider = "openai" | "anthropic" | "gemini";
export const DELEGATED_SECRET = "actual-vault-delegated-fixture-key";
const MODELS = {
  openai: "gpt-4o",
  anthropic: "claude-test",
  gemini: "gemini-test",
} as const;
export function canonicalDraft(providerId: CanonicalAiProvider = "openai") {
  return {
    ...aiConnectionDraft(providerId),
    model: MODELS[providerId],
    apiKey: DELEGATED_SECRET,
  };
}
export function delegatedAnswer(
  providerId: CanonicalAiProvider,
): BoundaryValue {
  if (providerId === "anthropic")
    return {
      type: "message",
      content: [{ type: "text", text: "Delegated answer" }],
      usage: { input_tokens: 9, output_tokens: 4 },
    };
  if (providerId === "gemini")
    return {
      candidates: [{ content: { parts: [{ text: "Delegated answer" }] } }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
    };
  return {
    choices: [{ message: { content: "Delegated answer" } }],
    usage: { prompt_tokens: 9, completion_tokens: 4 },
  };
}
export function canonicalCall(providerId: CanonicalAiProvider = "openai") {
  const draft = canonicalDraft(providerId);
  const api = modelApiOf(providerId);
  if (!api?.baseUrl) throw new Error("Expected canonical API");
  const base = new URL(api.baseUrl);
  const relative =
    providerId === "openai"
      ? "/chat/completions"
      : providerId === "anthropic"
        ? "/messages"
        : `/models/${draft.model}:generateContent`;
  const definition: HostedModelOperation = {
    providerId,
    operationId: "model.inference",
    method: "POST",
    origin: base.origin,
    path: `${base.pathname}${relative}`,
  };
  const body: BoundaryValue =
    providerId === "gemini"
      ? {
          contents: [{ role: "user", parts: [{ text: "Question" }] }],
          generationConfig: { maxOutputTokens: 100 },
        }
      : {
          model: draft.model,
          messages: [{ role: "user", content: "Question" }],
          max_tokens: 100,
        };
  return { definition, body, resource: api.baseUrl };
}
export function delegationFence() {
  return {
    signal: new AbortController().signal,
    assertCurrent() {},
    fetch: vi.fn<typeof fetch>(),
  };
}
export async function delegationFixture() {
  const base = await runtimeFixture();
  const lifetime = new AbortController();
  const fetcher = vi.fn<AiConnectionTransport["fetch"]>(async (input) => {
    const url = String(input);
    const provider = url.includes("anthropic.com")
      ? "anthropic"
      : url.includes("googleapis.com")
        ? "gemini"
        : "openai";
    return Response.json(delegatedAnswer(provider));
  });
  const release = bindAiConnectionTransport({
    fetch: fetcher,
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
  });
  return {
    ...base,
    fetcher,
    lifetime,
    async save(providerId: CanonicalAiProvider = "openai") {
      const saved = await saveAiConnection(canonicalDraft(providerId));
      fetcher.mockClear();
      return saved.connectionId;
    },
    async close() {
      release();
      lifetime.abort();
      await base.close();
    },
  };
}

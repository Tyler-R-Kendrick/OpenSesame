/**
 * Support agent over the operator-chosen local model plane (Ollama, LM Studio).
 *
 * When the browser has no Prompt API model ready, Support still needs something
 * that can answer. The Setup / Settings model provider is already that answer
 * for password-reset — reuse it here for chat. Only `kind: "local"` is accepted:
 * loopback endpoints, no API key, nothing leaves the machine.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type {
  SupportAgentAvailability,
  SupportAgentPort,
  SupportRequest,
  SupportRunOptions,
  SupportTurn,
} from "@opensesame/support-agent";
import {
  SUPPORT_LIMITS,
  SupportError,
  buildSupportInstructions,
  parseSupportTurn,
  sanitizeSupportRequest,
} from "@opensesame/support-agent";
import {
  type ModelProviderRecord,
  loadModelProvider,
} from "../../../lib/model-provider.js";
import { isLoopbackUrl } from "../../../lib/urls.js";

export type ProviderAgentOptions = {
  readonly record?: ModelProviderRecord;
  readonly fetch?: typeof fetch;
};

function emptyAnswer(): SupportTurn {
  return {
    answer:
      "The local model returned nothing this time. Ask again, or rephrase.",
    guide: null,
    suggestedQuestions: [],
  };
}

function toTurn(raw: string): SupportTurn {
  try {
    return parseSupportTurn(raw);
  } catch {
    const answer = raw.trim().slice(0, SUPPORT_LIMITS.maxAnswerChars);
    return {
      answer: answer.length > 0 ? answer : emptyAnswer().answer,
      guide: null,
      suggestedQuestions: [],
    };
  }
}

function renderTurn(request: SupportRequest): string {
  const lines: string[] = [];
  for (const message of request.history.slice(
    -SUPPORT_LIMITS.maxHistoryTurns,
  )) {
    lines.push(
      `${message.role === "user" ? "Person" : "Assistant"}: ${message.text}`,
    );
  }
  lines.push(`Person: ${request.question}`);
  return lines.join("\n");
}

type ChatMessage = { readonly role: string; readonly content: string };

/** OpenAI-route `/v1/chat/completions` vs Ollama's native `/api/chat`. */
function chatUrl(record: ModelProviderRecord) {
  const base = record.endpoint.replace(/\/$/, "");
  if (base.endsWith("/v1") || base.includes("/v1/")) {
    const root = base.endsWith("/v1")
      ? base
      : base.includes("/chat/completions")
        ? base.slice(0, base.indexOf("/chat/completions"))
        : base;
    return {
      url: `${root.replace(/\/$/, "")}/chat/completions`,
      usesChatCompletions: true,
    };
  }
  return { url: `${base}/api/chat`, usesChatCompletions: false };
}

function chatBody(
  record: ModelProviderRecord,
  messages: readonly ChatMessage[],
  usesChatCompletions: boolean,
): string {
  const model = record.model.trim() || "llama3.2";
  if (usesChatCompletions) {
    return JSON.stringify({ model, temperature: 0.2, messages });
  }
  return JSON.stringify({ model, stream: false, messages });
}

function readAnswer(
  payload: BoundaryValue,
  usesChatCompletions: boolean,
): string {
  if (!isJsonObject(payload)) return "";
  if (usesChatCompletions) {
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) return "";
    const first: BoundaryValue = choices[0];
    if (!isJsonObject(first)) return "";
    const message = first.message;
    if (!isJsonObject(message)) return "";
    return isString(message.content) ? message.content : "";
  }
  const message = payload.message;
  if (!isJsonObject(message)) return "";
  return isString(message.content) ? message.content : "";
}

/**
 * A configured local provider that Support may call. Hosted providers stay on
 * the AG-UI path (same-origin + consent); a non-loopback "local" record is
 * refused rather than phoning home from the support panel.
 */
export function readLocalSupportProvider(
  record: ModelProviderRecord = loadModelProvider(),
): ModelProviderRecord | null {
  if (record.kind !== "local") return null;
  if (!record.endpoint.trim()) return null;
  if (!isLoopbackUrl(record.endpoint)) return null;
  return record;
}

export function createProviderSupportAgent(
  options: ProviderAgentOptions = {},
): SupportAgentPort | null {
  const record = readLocalSupportProvider(
    options.record ?? loadModelProvider(),
  );
  if (record === null) return null;
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  let active: AbortController | null = null;

  return {
    async availability(): Promise<SupportAgentAvailability> {
      return { kind: "ready" };
    },

    async run(
      request: SupportRequest,
      runOptions: SupportRunOptions,
    ): Promise<SupportTurn> {
      if (runOptions.signal.aborted) {
        throw new SupportError(
          "AGENT_ABORTED",
          "The support request was cancelled.",
        );
      }
      const sanitized = sanitizeSupportRequest(request);
      const instructions = buildSupportInstructions(sanitized.context);
      const userText = renderTurn(sanitized);
      const route = chatUrl(record);
      const messages = [
        { role: "system", content: instructions },
        { role: "user", content: userText },
      ] as const satisfies readonly ChatMessage[];

      const controller = new AbortController();
      active = controller;
      const forward = (): void => controller.abort();
      if (runOptions.signal.aborted) controller.abort();
      else runOptions.signal.addEventListener("abort", forward, { once: true });

      try {
        const response = await fetchImpl(route.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: chatBody(record, messages, route.usesChatCompletions),
          signal: controller.signal,
          credentials: "omit",
        });
        if (!response.ok) {
          throw new SupportError(
            "AGENT_PROTOCOL_ERROR",
            `local model HTTP ${response.status}`,
          );
        }
        const payload: BoundaryValue = await response.json();
        return toTurn(readAnswer(payload, route.usesChatCompletions));
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new SupportError(
            "AGENT_ABORTED",
            "The support request was cancelled.",
          );
        }
        if (cause instanceof SupportError) throw cause;
        throw new SupportError(
          "AGENT_UNAVAILABLE",
          "The configured local model did not answer.",
        );
      } finally {
        runOptions.signal.removeEventListener("abort", forward);
        if (active === controller) active = null;
      }
    },

    destroy(): void {
      active?.abort();
      active = null;
    },
  };
}

/** App-facing constructor: the configured local model, or null. */
export function createProviderAgent(): SupportAgentPort | null {
  return createProviderSupportAgent();
}

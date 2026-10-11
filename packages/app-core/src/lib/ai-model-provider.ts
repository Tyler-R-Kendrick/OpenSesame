/**
 * What the app knows about a hosted model provider from the one catalog
 * (ADR 0139, ADR 0189): which rows are model providers, and how each is spoken
 * to. The protocol is a closed name the catalog carries; nothing here reads a
 * path, a header or a host from anywhere else.
 */
import type { ModelApi, Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";

export const MODEL_PROTOCOL_LABEL = {
  openai_chat: "OpenAI-compatible",
  anthropic_messages: "Anthropic Messages",
  gemini_generate_content: "Gemini",
  rest_json: "Provider REST",
} as const satisfies Record<ModelApi["protocol"], string>;

/** Does "AI model providers" own this row? */
export function isAiModelProvider(
  provider: Pick<Provider, "category">,
): boolean {
  return provider.category === "ai_model_provider";
}

/** How the catalog says this provider is spoken to, or `null` for a row that is not a model provider. */
export function modelApiOf(providerId: string): ModelApi | null {
  return catalogProvider(providerId)?.modelApi ?? null;
}

export function modelProtocolLabel(providerId: string): string | null {
  const api = modelApiOf(providerId);
  return api ? MODEL_PROTOCOL_LABEL[api.protocol] : null;
}

/** The host this provider's models are served from, or `null` when the endpoint is the person's own. */
export function modelApiHost(providerId: string): string | null {
  const base = modelApiOf(providerId)?.baseUrl;
  return base ? new URL(base).host : null;
}

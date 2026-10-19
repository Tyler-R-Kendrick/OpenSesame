import { modelApiOf } from "../ai-model-provider.js";
import { catalogProvider } from "../connector-catalog.js";
import type { AiConnectionDraft, AiInferenceFamily } from "./types.js";

export const AI_CONNECTION_FAMILIES = [
  { id: "openai_chat", label: "OpenAI Chat Completions" },
  { id: "openai_responses", label: "OpenAI Responses" },
  { id: "anthropic_messages", label: "Anthropic Messages" },
  { id: "gemini_generate_content", label: "Gemini Generate Content" },
] as const;

export function isAiConnectionFamily(
  value: string,
): value is AiInferenceFamily {
  return AI_CONNECTION_FAMILIES.some((family) => family.id === value);
}

export function aiConnectionFamilies(providerId: string) {
  const preset = aiConnectionPreset(providerId);
  return AI_CONNECTION_FAMILIES.filter(
    (family) =>
      providerId === "byo-ai" ||
      family.id === preset?.family ||
      (["openai", "azure-openai"].includes(providerId) &&
        family.id === "openai_responses"),
  );
}

/** Native catalog metadata supplies partner defaults; BYO exposes the same families. */
export function aiConnectionPreset(providerId: string) {
  if (providerId === "google-vertex")
    return {
      providerId,
      name: "Google Vertex AI",
      family: "gemini_generate_content" as const,
      baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
      vertex: {
        project: "",
        location: "us-central1",
        credential: "service-account",
      } as const,
    };
  if (providerId === "azure-openai")
    return {
      providerId,
      name: "Azure OpenAI",
      family: "openai_chat" as const,
      baseUrl: "",
      azure: { api: "v1", credential: "api-key" } as const,
    };
  if (providerId === "byo-ai")
    return {
      providerId,
      name: "BYO AI",
      family: "openai_chat" as const,
      baseUrl: "",
    };
  const api = modelApiOf(providerId);
  if (!api || !isAiConnectionFamily(api.protocol)) return null;
  return {
    providerId,
    name: catalogProvider(providerId)?.displayName ?? providerId,
    family: api.protocol,
    baseUrl: api.baseUrl ?? "",
  };
}

export function isAiConnectionProvider(providerId: string): boolean {
  // The complete Vertex form lands before its catalog route is advertised.
  return (
    providerId !== "google-vertex" && aiConnectionPreset(providerId) !== null
  );
}

export function aiConnectionDraft(providerId: string): AiConnectionDraft {
  const preset = aiConnectionPreset(providerId);
  if (!preset) throw new Error("This provider has no supported AI protocol.");
  return {
    ...preset,
    model: "",
    authentication: "api-key",
    apiKey: "",
    tokenParameter: ["openai", "byo-ai", "azure-openai"].includes(providerId)
      ? "max_completion_tokens"
      : "max_tokens",
  };
}

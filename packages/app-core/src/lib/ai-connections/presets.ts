import { modelApiOf } from "../ai-model-provider.js";
import { catalogProvider } from "../connector-catalog.js";
import { bedrockResourceBase } from "./bedrock-target.js";
import type { AiConnectionDraft, AiInferenceFamily } from "./types.js";

export const AI_CONNECTION_FAMILIES = [
  { id: "bedrock_converse", label: "Amazon Bedrock Converse" },
  { id: "openai_chat", label: "OpenAI Chat Completions" },
  { id: "openai_responses", label: "OpenAI Responses" },
  { id: "anthropic_messages", label: "Anthropic Messages" },
  { id: "gemini_generate_content", label: "Gemini Generate Content" },
  { id: "replicate_predictions", label: "Replicate predictions" },
  { id: "elevenlabs_scribe", label: "ElevenLabs Scribe transcription" },
  { id: "deepgram_listen", label: "Deepgram transcription" },
  { id: "assemblyai_transcript", label: "AssemblyAI transcription" },
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
  if (providerId === "assemblyai")
    return {
      providerId,
      name: "AssemblyAI",
      family: "assemblyai_transcript" as const,
      baseUrl: "https://api.assemblyai.com/v2",
      model: "universal-3-5-pro",
    };
  if (providerId === "deepgram")
    return {
      providerId,
      name: "Deepgram",
      family: "deepgram_listen" as const,
      baseUrl: "https://api.deepgram.com/v1",
      model: "nova-3",
    };
  if (providerId === "elevenlabs")
    return {
      providerId,
      name: "ElevenLabs",
      family: "elevenlabs_scribe" as const,
      baseUrl: "https://api.elevenlabs.io/v1",
      model: "scribe_v2",
    };
  if (providerId === "replicate")
    return {
      providerId,
      name: "Replicate",
      family: "replicate_predictions" as const,
      baseUrl: "https://api.replicate.com/v1",
    };
  if (providerId === "aws-bedrock") {
    const bedrock = { region: "us-east-1", credential: "sigv4" } as const;
    return {
      providerId,
      name: "Amazon Bedrock",
      family: "bedrock_converse" as const,
      baseUrl: bedrockResourceBase(bedrock),
      bedrock,
    };
  }
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
  return aiConnectionPreset(providerId) !== null;
}

export function aiConnectionDraft(providerId: string): AiConnectionDraft {
  const preset = aiConnectionPreset(providerId);
  if (!preset) throw new Error("This provider has no supported AI protocol.");
  return {
    ...preset,
    model:
      preset.family === "elevenlabs_scribe" ||
      preset.family === "deepgram_listen" ||
      preset.family === "assemblyai_transcript"
        ? preset.model
        : "",
    authentication: "api-key",
    apiKey: "",
    tokenParameter: ["openai", "byo-ai", "azure-openai"].includes(providerId)
      ? "max_completion_tokens"
      : "max_tokens",
  };
}

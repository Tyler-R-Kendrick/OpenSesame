import type { AiInferenceFamily } from "../hosted-model-authority.js";
import type { BedrockAiTarget } from "./bedrock-target.js";
import type { VertexAiTarget } from "./vertex-target.js";
export type { AiInferenceFamily } from "../hosted-model-authority.js";

/** Azure target metadata is public; the supplied key or Entra token is not. */
export type AzureOpenAiTarget =
  | { api: "v1"; credential: "api-key" | "entra-token" }
  | {
      api: "dated-chat";
      apiVersion: string;
      credential: "api-key" | "entra-token";
    };

/** Public protocol configuration is separate from the write-only credential. */
export type AiConnectionDraft = {
  providerId: string;
  name: string;
  family: AiInferenceFamily;
  baseUrl: string;
  model: string;
  authentication: "api-key" | "none";
  apiKey: string;
  tokenParameter: "max_tokens" | "max_completion_tokens";
  /** Unactivated until strict configuration and persistence support this target. */
  azure?: AzureOpenAiTarget;
  vertex?: VertexAiTarget;
  bedrock?: BedrockAiTarget;
};

export type AiConnectionTransport = {
  /** Acquire one route snapshot at an explicit workflow boundary, before credentials. */
  capture?: () => AiConnectionTransport;
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  assertCurrent(): void;
  signal: AbortSignal;
  /** The same captured egress authority as inference; absence grants no readiness. */
  assertEndpointAllowed?: (endpoint: string) => void;
};

export class AiConnectionError extends Error {
  constructor(
    readonly code:
      | "configuration"
      | "authentication"
      | "network"
      | "response"
      | "stale",
    message: string,
  ) {
    super(message);
    this.name = "AiConnectionError";
  }
}

/** Transcription families admitted by the current shared AI configuration. */
export function isAiSpeechFamily(
  family: string | undefined,
): family is "elevenlabs_scribe" | "deepgram_listen" {
  return family === "elevenlabs_scribe" || family === "deepgram_listen";
}

/** Implemented finite jobs keep explicit user cancellation separate from owner loss. */
export function isAiRemoteJobFamily(
  family: string | undefined,
): family is "replicate_predictions" | "assemblyai_transcript" {
  return (
    family === "replicate_predictions" || family === "assemblyai_transcript"
  );
}

/** Finite protocols cannot borrow the generic request or text-stream builders. */
export function textAiFamily(family: AiInferenceFamily) {
  if (
    family === "bedrock_converse" ||
    family === "replicate_predictions" ||
    isAiSpeechFamily(family)
  )
    throw new AiConnectionError(
      "configuration",
      "Use this family's signed or finite protocol adapter.",
    );
  return family;
}

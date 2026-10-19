import type { CallProtocol } from "../model-keys/protocols.js";
import type { BedrockAiTarget } from "./bedrock-target.js";
import type { VertexAiTarget } from "./vertex-target.js";
export type AiInferenceFamily =
  | CallProtocol
  | "openai_responses"
  | "bedrock_converse"
  | "replicate_predictions"
  | "elevenlabs_scribe";

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

/** Finite protocols cannot borrow the generic request or text-stream builders. */
export function textAiFamily(family: AiInferenceFamily) {
  if (
    family === "bedrock_converse" ||
    family === "replicate_predictions" ||
    family === "elevenlabs_scribe"
  )
    throw new AiConnectionError(
      "configuration",
      "Use this family's signed or finite protocol adapter.",
    );
  return family;
}

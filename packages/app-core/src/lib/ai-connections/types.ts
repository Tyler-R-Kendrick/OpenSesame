import type { CallProtocol } from "../model-keys/protocols.js";
export type AiInferenceFamily = CallProtocol | "openai_responses";

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
};

export type AiConnectionTransport = {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  assertCurrent(): void;
  signal: AbortSignal;
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

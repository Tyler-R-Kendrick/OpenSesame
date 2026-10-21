import type { BoundaryValue } from "@opensesame/os-domain";
/** Shared model authority port. Provider implementations are installed by their capability. */
export type CallProtocol =
  | "openai_chat"
  | "anthropic_messages"
  | "gemini_generate_content";
export type AiInferenceFamily =
  | CallProtocol
  | "stability_sd3"
  | "openai_responses"
  | "bedrock_converse"
  | "replicate_predictions"
  | "elevenlabs_scribe"
  | "deepgram_listen"
  | "assemblyai_transcript";
export type HostedModelTransport = {
  fetch: typeof fetch;
  assertCurrent: () => void;
};
export type HostedModelFence = HostedModelTransport & { signal: AbortSignal };
export type HostedModelConnection = {
  connectionId: string;
  providerId: string;
  status: string;
  method: string;
  /** Validated saved protocol; absence preserves legacy text-provider behavior. */
  family?: AiInferenceFamily;
  model?: string;
  endpoint?: string;
  name?: string;
};
export type HostedModelOperation = {
  providerId: string;
  operationId: string;
  method: "GET" | "POST";
  origin?: string;
  path: string;
  headers?: Record<string, string>;
  /** Called once, just before a request can leave. A failure before it cost the provider nothing. */
  onDispatch?: () => void;
};
export type HostedModelAuthority = HostedModelTransport & {
  read: (connectionId: string) => HostedModelConnection | null;
  connections: () => readonly HostedModelConnection[];
  execute: (
    connectionId: string,
    definition: HostedModelOperation,
    body: BoundaryValue,
    project: (body: BoundaryValue) => BoundaryValue,
    fence: HostedModelFence,
  ) => Promise<BoundaryValue>;
};
let active: HostedModelAuthority | null = null;
export function bindHostedModelAuthority(
  authority: HostedModelAuthority,
): () => void {
  active = authority;
  return () => {
    if (active === authority) active = null;
  };
}
/** Captured adapters remain bound to their original capability activation. */
export function hostedModelAuthority(): HostedModelAuthority | null {
  if (!active) return null;
  try {
    active.assertCurrent();
    return active;
  } catch {
    return null;
  }
}

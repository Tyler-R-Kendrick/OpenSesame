import { AiConnectionError, type AiConnectionTransport } from "./types.js";

let active: AiConnectionTransport | null = null;

export function bindAiConnectionTransport(
  transport: AiConnectionTransport,
): () => void {
  active = transport;
  return () => {
    if (active === transport) active = null;
  };
}

export function aiConnectionTransport(): AiConnectionTransport {
  if (!active)
    throw new AiConnectionError(
      "stale",
      "Enable External connectors before connecting an AI service.",
    );
  active.assertCurrent();
  active.signal.throwIfAborted();
  return active;
}

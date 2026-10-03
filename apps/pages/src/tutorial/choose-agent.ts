/**
 * Which agent answers — and therefore whether a question leaves the device.
 *
 * Split from `session.ts`, which owns the conversation: this is a pure choice
 * over what the device already has, with no session, no panel and no React.
 */
import type {
  SupportAgentAvailability,
  SupportAgentPort,
} from "@opensesame/support-agent";
import type { SupportTransport } from "./session.js";

export type SupportAgentChoice = {
  readonly port: SupportAgentPort;
  readonly transport: SupportTransport;
};

/**
 * Which agent answers — and therefore whether a question leaves the device.
 *
 * Preference order:
 *  1. Browser Prompt API when its model is already ready (shared, no download).
 *  2. A configured *local* model provider (Ollama / LM Studio on loopback) —
 *     already chosen in Setup / Settings, and already on the machine.
 *  3. Browser Prompt API while downloadable/downloading (offer the one-time
 *     browser download rather than quietly sending prompts off-device).
 *  4. Same-origin AG-UI remote endpoint.
 *  5. The local port's honest unavailable reason, or `absent`.
 */
export function chooseSupportAgent(
  local: SupportAgentPort | null,
  localState: SupportAgentAvailability | null,
  provider: SupportAgentPort | null,
  openRemote: () => SupportAgentPort | null,
  absent: SupportAgentPort,
): SupportAgentChoice {
  if (local !== null && localState?.kind === "ready") {
    return { port: local, transport: "on-device" };
  }
  if (provider !== null) {
    return { port: provider, transport: "on-device" };
  }
  const browserPending =
    local !== null &&
    localState !== null &&
    (localState.kind === "downloadable" || localState.kind === "downloading");
  if (browserPending) return { port: local, transport: "on-device" };
  const remote = openRemote();
  if (remote !== null) {
    // Nothing may hold a second provider session open behind the one in use.
    local?.destroy();
    return { port: remote, transport: "remote" };
  }
  if (local !== null) return { port: local, transport: "on-device" };
  return { port: absent, transport: "none" };
}

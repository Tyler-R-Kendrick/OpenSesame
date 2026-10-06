import {
  type SupportAgentAvailability,
  SupportError,
} from "@opensesame/support-agent";
import type { SupportEngine, SupportTransport } from "./engine.js";

/** Availability failures cannot prevent a local authored guide from running. */
export async function refreshEngineAvailability(
  ensure: () => Promise<SupportEngine | null>,
  current: () => SupportEngine | null,
  publish: (view: {
    availability: SupportAgentAvailability;
    transport: SupportTransport;
    warning: string | null;
  }) => void,
  failed: () => void,
): Promise<void> {
  const loaded = await ensure();
  if (!loaded || current() !== loaded) return;
  try {
    const availability = await loaded.session.availability();
    if (current() !== loaded) return;
    publish({
      availability,
      transport: loaded.transport,
      warning: loaded.warning,
    });
  } catch (cause) {
    if (cause instanceof SupportError && cause.code === "AGENT_ABORTED") return;
    if (current() === loaded) failed();
  }
}

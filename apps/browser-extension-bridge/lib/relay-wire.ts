/** The message between the relay and the background (ADR 0199): the page's own message, carried whole. */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";

export const RELAY_MESSAGE = "opensesame.bridge.relay";

/** The page's message inside a relay message, for the background to decode again; `null` if it is not one. */
export function relayedMessage(message: BoundaryValue): BoundaryValue | null {
  if (!isJsonObject(message) || message.type !== RELAY_MESSAGE) return null;
  return message.message ?? null;
}

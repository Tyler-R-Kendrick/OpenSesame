/**
 * Cross-tab hint that the durable composition documents changed.
 *
 * The message is a *hint only*: a receiver re-reads durable storage and
 * decides for itself. Its content is never trusted, so a message from any
 * origin-local script can at most cause one extra read.
 */

import { CAPABILITIES_CHANNEL } from "./keys.js";

let channel: BroadcastChannel | null | undefined;

function open(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(CAPABILITIES_CHANNEL);
  } catch {
    channel = null;
  }
  return channel;
}

/** Tell other tabs to re-read durable state. Fire and forget. */
export function postCapabilitiesChanged(): void {
  try {
    open()?.postMessage({ type: "changed" });
  } catch {
    // A closed channel loses the hint; the next revalidation reads anyway.
  }
}

/** Run `hint` on every message, ignoring its content. Returns an unsubscribe. */
export function subscribeCapabilitiesChanged(hint: () => void): () => void {
  const target = open();
  if (!target) return () => undefined;
  const onMessage = () => hint();
  target.addEventListener("message", onMessage);
  return () => target.removeEventListener("message", onMessage);
}

/** Test-only: drop the channel so a case gets a fresh one. */
export function resetCapabilitiesChannelForTest(): void {
  try {
    channel?.close();
  } catch {
    // already closed
  }
  channel = undefined;
}

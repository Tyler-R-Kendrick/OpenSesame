/**
 * The carriers a live session may name (ADR 0148 §6), as app-core's
 * `CarrierFactory`. Each client loads only when a session names its kind:
 * a profile with no carriers fetches none of them, and nothing here runs at
 * import.
 *
 * Every carrier gets the same two things — the topic, derived from the link
 * secret, and frames of sealed codes — so what one could read, all could:
 * nothing but noise to anyone who does not hold the link.
 */

import type {
  Carrier,
  CarrierFactory,
} from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";

/** How long a carrier may take to connect before it counts as down. */
export const CONNECT_MS = 10_000;

/** Reject if `work` has not settled within `CONNECT_MS`. */
export function withinConnect<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("carrier_timeout")),
      CONNECT_MS,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function open(spec: CarrierSpec, topic: string): Promise<Carrier> {
  switch (spec.kind) {
    case "broadcast":
      return (await import("./broadcast.js")).broadcastCarrier(topic);
    case "ntfy":
      return (await import("./ntfy.js")).ntfyCarrier(spec, topic);
    case "nostr":
      return (await import("./nostr.js")).nostrCarrier(spec, topic);
    case "mqtt":
      return (await import("./mqtt.js")).mqttCarrier(spec, topic);
    case "nats":
      return (await import("./nats.js")).natsCarrier(spec, topic);
  }
}

export const carriers: CarrierFactory = (spec, topic) =>
  withinConnect(open(spec, topic));

/**
 * The carriers a live session may name (ADR 0150 §6), as app-core's
 * `CarrierFactory`. Each client loads only when a session names its kind:
 * a profile with no carriers fetches none of them, and nothing here runs at
 * import.
 *
 * Every carrier gets the same two things — the topic, derived from the link
 * secret, and frames of sealed codes — so what one could read, all could:
 * nothing but noise to anyone who does not hold the link.
 *
 * And every carrier is asked of the installation first (`allowed.ts`): one
 * the plan does not allow is refused as `CarrierBlocked` before a socket
 * opens, and shown to the person as blocked, not as unreachable (ADR 0150
 * §7).
 */

import type { EgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import {
  type Carrier,
  CarrierBlocked,
  type CarrierFactory,
} from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";
import { type CarrierGate, carrierRefusal } from "./allowed.js";

/** How long a carrier may take to connect before it counts as down. */
export const CONNECT_MS = 10_000;

/**
 * Reject if `start` has not produced a carrier within `ms`, and abort what it
 * began. A carrier that arrives after that is closed on the spot: the caller
 * was told it failed and will never hold it, so nobody else could.
 */
export function withinConnect<T extends Readonly<{ close(): void }>>(
  start: (signal: AbortSignal) => Promise<T>,
  ms: number = CONNECT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      controller.abort();
      reject(new Error("carrier_timeout"));
    }, ms);
    start(controller.signal).then(
      (carrier) => {
        clearTimeout(timer);
        if (late) carrier.close();
        else resolve(carrier);
      },
      (error) => {
        clearTimeout(timer);
        if (!late) reject(error);
      },
    );
  });
}

async function open(
  spec: CarrierSpec,
  topic: string,
  egress: EgressPort,
  signal: AbortSignal,
): Promise<Carrier> {
  switch (spec.kind) {
    case "broadcast":
      return (await import("./broadcast.js")).broadcastCarrier(topic);
    case "ntfy":
      return (await import("./ntfy.js")).ntfyCarrier(
        spec,
        topic,
        egress,
        signal,
      );
    case "nostr":
      return (await import("./nostr.js")).nostrCarrier(spec, topic);
    case "mqtt":
      return (await import("./mqtt.js")).mqttCarrier(spec, topic);
    case "nats":
      return (await import("./nats.js")).natsCarrier(spec, topic);
  }
}

/** The carrier factory for one activation of the capability. */
export function carrierFactory(gate: CarrierGate): CarrierFactory {
  return async (spec, topic) => {
    const refusal = carrierRefusal(spec, gate);
    if (refusal !== null) throw new CarrierBlocked(refusal);
    return withinConnect((signal) => open(spec, topic, gate.egress, signal));
  };
}

/** What a session gets while the capability is not active: nothing opens. */
export const carriersUnavailable: CarrierFactory = async () => {
  throw new CarrierBlocked("capability-not-active");
};

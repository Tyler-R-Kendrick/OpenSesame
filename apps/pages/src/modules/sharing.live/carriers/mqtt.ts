/**
 * An MQTT broker over WebSocket as a carrier (Mosquitto, EMQX, HiveMQ,
 * NanoMQ — one's own on a tailnet or behind a tunnel): frames are published
 * at QoS 1, not retained, on `opensesame/live/<topic>`.
 *
 * The client does not retry until it has connected once. `connectAsync`
 * retries a first connection forever by default — the promise never
 * rejects, and a closed port is knocked on every few seconds until the tab
 * closes, out of reach of leaving, ending or locking — so it is asked to
 * reject on the first failure, with reconnecting held off until a broker has
 * answered. After that a dropped connection is retried, and `close()` ends it.
 *
 * Its timers are the page's own. By default the client runs them in a worker
 * started from a Blob URL that it revokes on the next tick, which WebKit
 * (Safari) can lose the race to load: the worker fails, the keepalive with
 * it, and the page logs the failed load. A carrier lives for an exchange of
 * codes and reconnects if a broker drops it, so a throttled timer costs it
 * nothing a worker would have saved.
 */

import type { Carrier } from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";
import mqtt from "mqtt";

const RECONNECT_MS = 3000;

/** How a broker is connected to; a test stands another in. */
export type Connect = typeof mqtt.connectAsync;

export async function mqttCarrier(
  spec: CarrierSpec,
  topic: string,
  connect: Connect = mqtt.connectAsync,
): Promise<Carrier> {
  const subject = `opensesame/live/${topic}`;
  const client = await connect(
    spec.url,
    {
      username: spec.username,
      password: spec.password ?? spec.token,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 8000,
      timerVariant: "native",
    },
    false,
  );
  try {
    await client.subscribeAsync(subject, { qos: 1 });
  } catch (error) {
    await client.endAsync(true);
    throw error;
  }
  client.options.reconnectPeriod = RECONNECT_MS;
  const stops = new Set<() => void>();
  return {
    async post(text) {
      await client.publishAsync(subject, text, { qos: 1, retain: false });
    },
    listen(onText) {
      const handler = (at: string, payload: Uint8Array) => {
        if (at === subject) onText(new TextDecoder().decode(payload));
      };
      client.on("message", handler);
      const stop = () => {
        client.off("message", handler);
      };
      stops.add(stop);
      return stop;
    },
    close() {
      for (const stop of stops) stop();
      void client.endAsync(true);
    },
  };
}

/**
 * An MQTT broker over WebSocket as a carrier (Mosquitto, EMQX, HiveMQ,
 * NanoMQ — one's own on a tailnet or behind a tunnel): frames are published
 * at QoS 1, not retained, on `opensesame/live/<topic>`.
 */

import type { Carrier } from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";
import mqtt from "mqtt";

export async function mqttCarrier(
  spec: CarrierSpec,
  topic: string,
): Promise<Carrier> {
  const subject = `opensesame/live/${topic}`;
  const client = await mqtt.connectAsync(spec.url, {
    username: spec.username,
    password: spec.password ?? spec.token,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 8000,
  });
  await client.subscribeAsync(subject, { qos: 1 });
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

/**
 * A NATS server's WebSocket listener as a carrier (the official
 * `@nats-io/nats-core` client): frames are published on
 * `opensesame.live.<topic>`. A user and password or a token authenticate
 * the connection; the server's own authorization decides the subject.
 */

import { type ConnectionOptions, wsconnect } from "@nats-io/nats-core";
import type { Carrier } from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";

export async function natsCarrier(
  spec: CarrierSpec,
  topic: string,
): Promise<Carrier> {
  const subject = `opensesame.live.${topic}`;
  const options: ConnectionOptions = {
    servers: spec.url,
    reconnect: true,
    maxReconnectAttempts: -1,
  };
  if (spec.username) options.user = spec.username;
  if (spec.password) options.pass = spec.password;
  if (spec.token) options.token = spec.token;
  const connection = await wsconnect(options);
  const stops = new Set<() => void>();
  return {
    async post(text) {
      connection.publish(subject, text);
      await connection.flush();
    },
    listen(onText) {
      const sub = connection.subscribe(subject, {
        callback: (error, message) => {
          if (!error) onText(message.string());
        },
      });
      const stop = () => sub.unsubscribe();
      stops.add(stop);
      return stop;
    },
    close() {
      for (const stop of stops) stop();
      void connection.close();
    },
  };
}

/**
 * A NATS server's WebSocket listener as a carrier (the official
 * `@nats-io/nats-core` client). Everything a session does there lives under
 * one subject, `opensesame.live.<topic>`, derived from the link secret:
 *
 * - the pairing codes, on the subject itself (ADR 0150 §6);
 * - each relayed seat's sealed session, on a subject below it
 *   (`channel`, `seat-channel.ts`, ADR 0167);
 * - on the owner's side, the session as a NATS service (`opensesame-live`,
 *   discoverable over `$SRV`), whose `info` endpoint says the tab is up.
 *
 * It signs in with what the spec names: a user credential (JWT and seed —
 * minted for this session, or the owner's own), a token, or a user and
 * password. The server's own authorization decides the subjects; a minted
 * credential allows only this session's (`nats-credentials.ts`). Request
 * inboxes live under the session's subject too, so a credential confined to
 * it can still ask and be answered.
 */

import {
  type ConnectionOptions,
  type NatsConnection,
  jwtAuthenticator,
  wsconnect,
} from "@nats-io/nats-core";
import type {
  Carrier,
  CarrierRole,
} from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";

const SERVICE = "opensesame-live";

function connectOptions(spec: CarrierSpec, base: string): ConnectionOptions {
  const options: ConnectionOptions = {
    servers: spec.url,
    reconnect: true,
    maxReconnectAttempts: -1,
    inboxPrefix: `${base}._INBOX`,
  };
  if (spec.jwt && spec.seed)
    options.authenticator = jwtAuthenticator(
      spec.jwt,
      new TextEncoder().encode(spec.seed),
    );
  if (spec.username) options.user = spec.username;
  if (spec.password) options.pass = spec.password;
  if (spec.token) options.token = spec.token;
  return options;
}

/** Publish and subscribe on one subject of an open connection. */
function subjectCarrier(
  connection: NatsConnection,
  subject: string,
  onClose: () => void,
): Carrier {
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
      stops.clear();
      onClose();
    },
  };
}

/**
 * Register the session as a NATS service. It answers `$SRV` discovery and
 * `<subject>.info` with no more than that it is live; a server that does not
 * allow it costs the service, never the carrier.
 */
async function serve(
  connection: NatsConnection,
  base: string,
): Promise<(() => void) | null> {
  try {
    const { Svcm } = await import("@nats-io/services");
    const service = await new Svcm(connection).add({
      name: SERVICE,
      version: "1.0.0",
      description: "An OpenSesame live session, served by the owner's tab",
      metadata: { protocol: "osm-live-v1" },
      queue: "",
    });
    service.addEndpoint("info", {
      subject: `${base}.info`,
      handler: (error, message) => {
        if (!error) message.respond(JSON.stringify({ live: true }));
      },
    });
    return () => void service.stop();
  } catch {
    return null;
  }
}

export async function natsCarrier(
  spec: CarrierSpec,
  topic: string,
  role: CarrierRole = "joiner",
): Promise<Carrier> {
  const base = `opensesame.live.${topic}`;
  const connection = await wsconnect(connectOptions(spec, base));
  const stopService = role === "owner" ? await serve(connection, base) : null;
  const root = subjectCarrier(connection, base, () => {
    stopService?.();
    void connection.close();
  });
  return {
    ...root,
    // A seat's subject: closing it leaves the connection to the session.
    channel: (name) => subjectCarrier(connection, `${base}.${name}`, () => {}),
  };
}

/**
 * A NATS server's WebSocket listener as a carrier for a terminal (ADR 0196):
 * the Node counterpart of the browser's carrier in
 * `apps/pages/src/modules/sharing.live/carriers/nats.ts`, minus the service
 * the owner's tab registers. A terminal has no WebRTC, so this is the road a
 * device takes into a live session: everything under one subject,
 * `opensesame.live.<topic>`, derived from the link secret.
 *
 * - the pairing codes travel on the subject itself;
 * - each seat's sealed session travels on a subject below it (`channel`), over
 *   the same connection, which closing a channel leaves open.
 *
 * It signs in with what the link's spec names: a user credential (JWT and
 * seed), a token, or a user and password. Request inboxes live under the
 * session's subject too, so a credential confined to it can still be answered.
 *
 * Only NATS is carried: any other kind rejects, and the rendezvous marks it
 * failed and goes on with the rest.
 */

import {
  type ConnectionOptions,
  type NatsConnection,
  jwtAuthenticator,
  wsconnect,
} from "@nats-io/nats-core";
import type {
  Carrier,
  CarrierFactory,
} from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/routes.js";

/** Open a connection; `wsconnect` in production, a fake in a test. */
export type NatsConnect = (
  options: ConnectionOptions,
) => Promise<NatsConnection>;

/**
 * How long a closed carrier keeps its connection before draining it. The
 * guest waits for its goodbye to be posted before it lets the carriers go
 * (`LiveGuest.left`), so this is only the margin for the relay to take the
 * last frame off the socket; it is not what the goodbye depends on.
 */
export const CLOSE_GRACE_MS = 150;

/** The carriers a terminal opens, and a way to wait until they are closed. */
export type SettlingCarriers = CarrierFactory &
  Readonly<{ settled: () => Promise<void> }>;

export function connectOptions(
  spec: CarrierSpec,
  base: string,
): ConnectionOptions {
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

/** Let the connection finish what it was sent, then close it. */
async function retire(
  connection: NatsConnection,
  graceMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, graceMs));
  try {
    await connection.drain();
  } catch {
    await connection.close().catch(() => undefined);
  }
}

/**
 * The carriers a terminal opens over `connect`. `settled()` resolves once
 * every connection a closed carrier held has been drained, so a command can
 * wait for its last frame (the seat's goodbye) before the process exits.
 */
export function natsNodeCarriers(
  connect: NatsConnect = wsconnect,
  graceMs: number = CLOSE_GRACE_MS,
): SettlingCarriers {
  const retiring = new Set<Promise<void>>();
  const factory: CarrierFactory = async (spec, topic) => {
    if (spec.kind !== "nats") throw new Error("carrier_unsupported");
    const base = `opensesame.live.${topic}`;
    const connection = await connect(connectOptions(spec, base));
    let released = false;
    const root = subjectCarrier(connection, base, () => {
      if (released) return;
      released = true;
      const done: Promise<void> = retire(connection, graceMs).finally(() =>
        retiring.delete(done),
      );
      retiring.add(done);
    });
    return {
      ...root,
      // A seat's subject: closing it leaves the connection to the session.
      channel: (name) =>
        subjectCarrier(connection, `${base}.${name}`, () => undefined),
    };
  };
  return Object.assign(factory, {
    settled: async (): Promise<void> => {
      while (retiring.size > 0) await Promise.all([...retiring]);
    },
  });
}

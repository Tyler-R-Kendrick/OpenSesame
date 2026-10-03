/**
 * A Nostr relay as a carrier (NIP-01): frames ride ephemeral events
 * (NIP-01 ephemeral kinds 20000–29999; 25050 is ours, which a relay passes on and does not keep), tagged
 * with the topic, each signed by a key made for this carrier alone and
 * thrown away with it. `nostr-tools` checks every event's signature before
 * handing it on.
 */

import type { Carrier } from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";

export const LIVE_KIND = 25050;

export async function nostrCarrier(
  spec: CarrierSpec,
  topic: string,
): Promise<Carrier> {
  const relay = await Relay.connect(spec.url);
  const key = generateSecretKey();
  const stops = new Set<() => void>();
  return {
    async post(text) {
      const event = finalizeEvent(
        {
          kind: LIVE_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", topic]],
          content: text,
        },
        key,
      );
      await relay.publish(event);
    },
    listen(onText) {
      const sub = relay.subscribe(
        [
          {
            kinds: [LIVE_KIND],
            "#t": [topic],
            since: Math.floor(Date.now() / 1000) - 60,
          },
        ],
        { onevent: (event) => onText(event.content) },
      );
      const stop = () => sub.close();
      stops.add(stop);
      return stop;
    },
    close() {
      for (const stop of stops) stop();
      // A CLOSE frame leaves on a microtask; close the socket after it.
      setTimeout(() => relay.close(), 0);
    },
  };
}

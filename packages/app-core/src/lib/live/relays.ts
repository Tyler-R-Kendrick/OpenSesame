/**
 * The public relays that introduce two browsers (ADR 0148 §3), through
 * `nostr-tools`' pool: one socket per relay, every event's signature checked
 * before it is handed on.
 *
 * The defaults are three long-running public relays; an owner may name others
 * in `config/live-sessions.yaml`, and a link carries the owner's list so the
 * joiner meets them on the same ones.
 */

import { SimplePool } from "nostr-tools/pool";
import type { SignalTransport } from "./signal.js";

export const DEFAULT_RELAYS: readonly string[] = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

export function relayTransport(): SignalTransport {
  const pool = new SimplePool();
  return {
    subscribe(relays, filter, onEvent) {
      const sub = pool.subscribe(
        [...relays],
        {
          kinds: [...filter.kinds],
          "#p": [...filter["#p"]],
          since: filter.since,
        },
        { onevent: onEvent },
      );
      return () => sub.close();
    },
    async publish(relays, event) {
      // One relay accepting is enough: the peer listens on all of them.
      await Promise.any(pool.publish([...relays], event));
    },
    close(relays) {
      // A subscription's CLOSE frame leaves on a microtask; closing the
      // sockets in the same task would send it into a closed socket, which
      // the pool reports as an unhandled rejection. One task later, it has
      // gone.
      setTimeout(() => pool.close([...relays]), 0);
    },
  };
}

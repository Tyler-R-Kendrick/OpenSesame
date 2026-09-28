/**
 * A NIP-01 relay in the test process, reached through Playwright's
 * `routeWebSocket`: every page that opens a socket to a relay URL talks to
 * this instead, so two browser contexts meet on one relay with no server and
 * no network. It keeps nothing for ephemeral kinds (NIP-16, 20000–29999),
 * exactly as a public relay would not, and records every frame it was sent
 * so a check can say what a relay could have read.
 */

function matches(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since && event.created_at < filter.since) return false;
  if (filter.until && event.created_at > filter.until) return false;
  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const tag = key.slice(1);
    const values = event.tags
      .filter((entry) => entry[0] === tag)
      .map((entry) => entry[1]);
    if (!wanted.some((value) => values.includes(value))) return false;
  }
  return true;
}

export function createRelay() {
  const sockets = new Set();
  const stored = [];
  const frames = [];

  function deliver(event) {
    for (const socket of sockets) {
      for (const [id, filters] of socket.subs) {
        if (filters.some((filter) => matches(filter, event)))
          socket.ws.send(JSON.stringify(["EVENT", id, event]));
      }
    }
  }

  function receive(socket, raw) {
    frames.push(raw);
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const [type, ...rest] = message;
    if (type === "EVENT") {
      const [event] = rest;
      socket.ws.send(JSON.stringify(["OK", event.id, true, ""]));
      const ephemeral = event.kind >= 20000 && event.kind < 30000;
      if (!ephemeral) stored.push(event);
      deliver(event);
    } else if (type === "REQ") {
      const [id, ...filters] = rest;
      socket.subs.set(id, filters);
      for (const event of stored)
        if (filters.some((filter) => matches(filter, event)))
          socket.ws.send(JSON.stringify(["EVENT", id, event]));
      socket.ws.send(JSON.stringify(["EOSE", id]));
    } else if (type === "CLOSE") {
      socket.subs.delete(rest[0]);
    }
  }

  return {
    frames,
    /** Serve every relay socket a context opens. */
    async attach(context, pattern = /^wss?:\/\//) {
      await context.routeWebSocket(pattern, (ws) => {
        const socket = { ws, subs: new Map() };
        sockets.add(socket);
        ws.onMessage((raw) => receive(socket, String(raw)));
        ws.onClose(() => sockets.delete(socket));
      });
    },
  };
}

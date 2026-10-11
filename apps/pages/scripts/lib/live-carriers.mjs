/**
 * Code carriers for verify:live-join (ADR 0150 §6), each a real server on
 * this machine's loopback, the way an owner runs one on their own device or
 * tailnet: a NIP-01 Nostr relay and an MQTT broker (aedes) over WebSocket in
 * this process, and — when their pinned binaries are present — a real
 * nats-server with its WebSocket listener and a real ntfy server.
 *
 * Every server records what it was sent where it can, so a check can say
 * what a carrier could have read. A carrier whose binary is missing is
 * reported, never faked.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Aedes } from "aedes";
import { WebSocketServer, createWebSocketStream } from "ws";

export function freePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Stop a WebSocket server. `close()` alone waits for every client to leave,
 * and a page still open when a walk fails never does: the failure would be
 * hidden by a hang. So the clients are cut first.
 */
function closeSockets(wss) {
  for (const client of wss.clients) client.terminate();
  return new Promise((resolve) => wss.close(() => resolve()));
}

function matches(filter, event) {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since && event.created_at < filter.since) return false;
  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const values = event.tags
      .filter((entry) => entry[0] === key.slice(1))
      .map((entry) => entry[1]);
    if (!wanted.some((value) => values.includes(value))) return false;
  }
  return true;
}

/**
 * A NIP-01 relay on a real WebSocket: ephemeral kinds are passed, not kept.
 * On loopback unless `host` names another local address; a page served over
 * https may only reach one of those over `wss://`, so `tls` ({ key, cert })
 * makes it one.
 */
export async function startNostrRelay({ host = "127.0.0.1", tls } = {}) {
  const port = await freePort(host);
  const secure = tls ? https.createServer(tls) : null;
  const wss = secure
    ? new WebSocketServer({ server: secure })
    : new WebSocketServer({ host, port });
  if (secure)
    await new Promise((resolve) => secure.listen(port, host, resolve));
  const frames = [];
  const sockets = new Set();
  wss.on("connection", (ws) => {
    const socket = { ws, subs: new Map() };
    sockets.add(socket);
    ws.on("close", () => sockets.delete(socket));
    ws.on("message", (data) => {
      const raw = String(data);
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
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        for (const other of sockets)
          for (const [id, filters] of other.subs)
            if (filters.some((filter) => matches(filter, event)))
              other.ws.send(JSON.stringify(["EVENT", id, event]));
      } else if (type === "REQ") {
        const [id, ...filters] = rest;
        socket.subs.set(id, filters);
        ws.send(JSON.stringify(["EOSE", id]));
      } else if (type === "CLOSE") {
        socket.subs.delete(rest[0]);
      }
    });
  });
  return {
    kind: "nostr",
    url: `${secure ? "wss" : "ws"}://${host}:${port}`,
    frames,
    stop: async () => {
      await closeSockets(wss);
      if (secure) await new Promise((resolve) => secure.close(() => resolve()));
    },
  };
}

/**
 * Wait until the owner listens on `relay` (its subscription is in) and has
 * gone quiet; resolves to the frame count then, after which every frame is
 * somebody else's. A session's link can be on screen before its subscription
 * reaches the relay (later still through a TLS front), so a count taken at
 * once would credit the owner's own subscription to whoever came next.
 */
export async function ownerSettled(
  relay,
  { timeout = 15_000, quiet = 500 } = {},
) {
  const deadline = Date.now() + timeout;
  const listening = () =>
    relay.frames.some((frame) => frame.startsWith('["REQ"'));
  for (let seen = -1; ; ) {
    if (listening() && seen === relay.frames.length) return seen;
    if (Date.now() > deadline)
      throw new Error("the owner never listened on the carrier");
    seen = relay.frames.length;
    await new Promise((resolve) => setTimeout(resolve, quiet));
  }
}

/** An MQTT 3.1.1/5 broker (aedes) behind a WebSocket listener. */
export async function startMqttBroker() {
  const port = await freePort();
  const broker = await Aedes.createBroker();
  const frames = [];
  broker.on("publish", (packet, client) => {
    if (client) frames.push(String(packet.payload));
  });
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  wss.on("connection", (ws) => broker.handle(createWebSocketStream(ws)));
  return {
    kind: "mqtt",
    url: `ws://127.0.0.1:${port}`,
    frames,
    stop: async () => {
      await closeSockets(wss);
      await new Promise((resolve) => broker.close(() => resolve()));
    },
  };
}

function waitForPort(port, ms) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > until) reject(new Error(`port ${port} never opened`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

export async function spawnServer(binary, args, port) {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const hear = (chunk) => {
    output += chunk;
  };
  child.stdout.on("data", hear);
  child.stderr.on("data", hear);
  try {
    await waitForPort(port, 15_000);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${path.basename(binary)}: ${error.message}\n${output}`);
  }
  return {
    output: () => output,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** A real nats-server with its WebSocket listener, if its binary is here. */
export async function startNatsServer(binary) {
  if (!binary || !fs.existsSync(binary))
    return { kind: "nats", missing: binary };
  const [port, wsPort] = [await freePort(), await freePort()];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-nats-"));
  const config = path.join(dir, "nats.conf");
  fs.writeFileSync(
    config,
    `listen: "127.0.0.1:${port}"\nwebsocket {\n  listen: "127.0.0.1:${wsPort}"\n  no_tls: true\n}\n`,
  );
  const server = await spawnServer(binary, ["-c", config], wsPort);
  // A subscriber on everything: what the server passed on, anyone could have.
  const { wsconnect } = await import("@nats-io/nats-core");
  const watcher = await wsconnect({ servers: `ws://127.0.0.1:${wsPort}` });
  const frames = [];
  watcher.subscribe(">", {
    callback: (_error, message) => frames.push(message.string()),
  });
  return {
    kind: "nats",
    url: `ws://127.0.0.1:${wsPort}`,
    frames,
    ...server,
    stop: async () => {
      await watcher.close();
      await server.stop();
    },
  };
}

/** A real ntfy server (in-memory cache), if its binary is here. */
export async function startNtfyServer(binary) {
  if (!binary || !fs.existsSync(binary))
    return { kind: "ntfy", missing: binary };
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-ntfy-"));
  const config = path.join(dir, "server.yml");
  fs.writeFileSync(
    config,
    `base-url: "http://127.0.0.1:${port}"\nlisten-http: "127.0.0.1:${port}"\ncache-duration: "1h"\n`,
  );
  const server = await spawnServer(binary, ["serve", "--config", config], port);
  const url = `http://127.0.0.1:${port}`;
  const frames = [];
  return {
    kind: "ntfy",
    url,
    frames,
    ...server,
    /** Everything the server's cache holds on the topics it saw. */
    async collect(topics) {
      for (const topic of topics) {
        const response = await fetch(`${url}/${topic}/json?poll=1&since=all`);
        for (const line of (await response.text()).split("\n"))
          if (line) frames.push(JSON.parse(line).message ?? "");
      }
    },
  };
}

/**
 * A TURN server (RFC 5766, long-term credentials) on UDP: loopback unless
 * `host` names another local address, which it then listens and relays on.
 */
export async function startTurnServer({ host = "127.0.0.1" } = {}) {
  const { default: Turn } = await import("node-turn");
  const port = await freePort(host);
  const server = new Turn({
    authMech: "long-term",
    credentials: { live: "turn-credential-2026" },
    listeningIps: [host],
    relayIps: [host],
    listeningPort: port,
    debugLevel: "OFF",
  });
  server.start();
  return {
    url: `turn:${host}:${port}?transport=udp`,
    username: "live",
    credential: "turn-credential-2026",
    stop: async () => server.stop(),
  };
}

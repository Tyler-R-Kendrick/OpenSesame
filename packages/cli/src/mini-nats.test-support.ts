/**
 * A small in-process server that speaks the NATS client protocol over a real
 * WebSocket: INFO, CONNECT, PING, SUB, UNSUB, PUB and MSG. It is not
 * nats-server — no authorization, permissions, clustering or JetStream — but
 * it is enough for the official client to connect to, authenticate against and
 * route subjects through, which is what the terminal's carrier needs of it.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

export type Published = { subject: string; text: string };

type Command = { verb: string; args: string[]; payload: string };

/** What a socket delivered, as one buffer. */
function bytesOf(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/** The client reads binary frames only; text would be taken for nothing. */
function send(socket: WebSocket, text: string): void {
  socket.send(Buffer.from(text));
}

/** The next whole command in `buffer` and what follows it, or null. */
function nextCommand(
  buffer: Buffer,
): { command: Command; rest: Buffer } | null {
  const end = buffer.indexOf("\r\n");
  if (end < 0) return null;
  const [verb = "", ...args] = buffer.subarray(0, end).toString().split(" ");
  let used = end + 2;
  let payload = "";
  if (verb === "PUB") {
    const length = Number(args.at(-1));
    if (buffer.length < used + length + 2) return null;
    payload = buffer.subarray(used, used + length).toString();
    used += length + 2;
  }
  return { command: { verb, args, payload }, rest: buffer.subarray(used) };
}

export class MiniNats {
  /** What each client sent in its CONNECT, in order. */
  readonly connects: JsonObject[] = [];
  readonly published: Published[] = [];
  /** Resolves when any client's socket has closed. */
  readonly closed: Promise<void>;
  url = "";
  readonly #subs = new Map<WebSocket, Map<string, string>>();
  readonly #http = createServer();
  readonly #wss = new WebSocketServer({ server: this.#http });
  #onClose: () => void = () => undefined;

  private constructor(private readonly info: JsonObject) {
    this.closed = new Promise<void>((resolve) => {
      this.#onClose = resolve;
    });
    this.#wss.on("connection", (socket) => this.#accept(socket));
  }

  static async start(info: JsonObject = {}): Promise<MiniNats> {
    const server = new MiniNats(info);
    await new Promise<void>((resolve) =>
      server.#http.listen(0, "127.0.0.1", resolve),
    );
    const address = server.#http.address();
    if (address === null) throw new Error("the mini server has no port");
    // A TCP server's address is an AddressInfo; a pipe's is a string.
    const bound: AddressInfo = overlapCast(address);
    server.url = `ws://127.0.0.1:${bound.port}`;
    return server;
  }

  async stop(): Promise<void> {
    for (const socket of this.#wss.clients) socket.terminate();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  #accept(socket: WebSocket): void {
    this.#subs.set(socket, new Map());
    const info = {
      server_id: "mini",
      version: "2.10.0",
      proto: 1,
      headers: true,
      max_payload: 1048576,
      ...this.info,
    };
    send(socket, `INFO ${JSON.stringify(info)}\r\n`);
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("close", () => this.#onClose());
    socket.on("message", (data) => {
      buffer = Buffer.concat([buffer, bytesOf(data)]);
      for (let next = nextCommand(buffer); next; next = nextCommand(buffer)) {
        buffer = next.rest;
        this.#handle(socket, next.command);
      }
    });
  }

  #handle(socket: WebSocket, { verb, args, payload }: Command): void {
    const mine = this.#subs.get(socket);
    switch (verb) {
      case "CONNECT":
        this.connects.push(JSON.parse(args.join(" ")));
        return;
      case "PING":
        send(socket, "PONG\r\n");
        return;
      case "SUB":
        mine?.set(args.at(-1) ?? "", args[0] ?? "");
        return;
      case "UNSUB":
        mine?.delete(args[0] ?? "");
        return;
      case "PUB":
        this.#route(args[0] ?? "", payload);
        return;
    }
  }

  #route(subject: string, text: string): void {
    this.published.push({ subject, text });
    for (const [socket, table] of this.#subs)
      for (const [sid, wanted] of table)
        if (wanted === subject)
          send(
            socket,
            `MSG ${subject} ${sid} ${Buffer.byteLength(text)}\r\n${text}\r\n`,
          );
  }
}

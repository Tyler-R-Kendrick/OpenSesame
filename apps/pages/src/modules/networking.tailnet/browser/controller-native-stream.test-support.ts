/** Controlled typed Worker port and real owned HTTPS wire stand-in; no WASM claim. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { expect, vi } from "vitest";
import { z } from "zod";
import { BrowserNodeRequests } from "./controller-requests.js";
import { type HostEvent, HostMessage, type WorkerMessage } from "./protocol.js";

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function fixture() {
  const sent: ReturnType<typeof WorkerMessage.parse>[] = [];
  let active = true;
  let dispatch = (_message: ReturnType<typeof WorkerMessage.parse>) => {};
  const stop = vi.fn();
  const requests = new BrowserNodeRequests(
    {
      postMessage: (message) => {
        sent.push(message);
        dispatch(message);
      },
    },
    () => {
      if (!active) throw new Error("Original owner ended.");
    },
    () => true,
    () => true,
    stop,
    true,
  );
  return {
    requests,
    sent,
    stop,
    emit: (message: HostEvent) => requests.receive(HostMessage.parse(message)),
    dispatch: (callback: typeof dispatch) => {
      dispatch = callback;
    },
    withdraw: () => {
      active = false;
    },
    close: () => requests.close(),
  };
}
export type Fixture = ReturnType<typeof fixture>;
export const url = "https://api.example.test/events";
export function head(
  id = 1,
  patch: Partial<
    Extract<HostEvent, { kind: "nativeHTTPStream" }>["result"]
  > = {},
): HostEvent {
  return {
    kind: "nativeHTTPStream",
    id,
    result: {
      status: 200,
      statusText: "OK",
      url,
      headers: [["content-type", "text/event-stream"]],
      ...patch,
    },
  };
}
export function frame(
  id = 1,
  sequence = 1,
  body = new Uint8Array([7]),
  eof = false,
): HostEvent {
  return { kind: "nativeHTTPChunk", id, result: { sequence, body, eof } };
}
export async function begin(
  f: Fixture,
  signal?: AbortSignal,
  accept = "text/event-stream",
) {
  const pending = f.requests
    .capture(new AbortController().signal)
    .fetch(url, { headers: { accept }, signal });
  await vi.waitFor(() =>
    expect(f.sent).toContainEqual({ kind: "nativeHTTPReady" }),
  );
  f.emit({ kind: "nativeHTTPReady", ready: true });
  await vi.waitFor(() =>
    expect(f.sent).toContainEqual(
      expect.objectContaining({ kind: "nativeHTTPStream" }),
    ),
  );
  return { pending };
}
export async function credit(f: Fixture, id = 1, sequence = 1) {
  await vi.waitFor(() =>
    expect(f.sent).toContainEqual({ kind: "pullHTTP", id, sequence }),
  );
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "controller-native-stream-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  return {
    directory,
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
}
type WireEntry = {
  close(): void;
  incoming?: IncomingMessage;
  iterator?: AsyncIterator<Uint8Array>;
};
type Command = ReturnType<typeof WorkerMessage.parse>;
function openWire(
  message: Extract<Command, { kind: "nativeHTTPStream" }>,
  entries: Map<number, WireEntry>,
  cert: Buffer,
  emit: Fixture["emit"],
  errors: Error[],
) {
  const id = message.id;
  const request = httpsRequest(
    message.request.url,
    {
      ca: cert,
      method: message.request.method,
      headers: Object.fromEntries(message.request.headers),
    },
    (incoming) => {
      const entry = entries.get(id);
      if (!entry) {
        incoming.destroy();
        return;
      }
      entry.incoming = incoming;
      entry.iterator = incoming[Symbol.asyncIterator]();
      emit({
        kind: "nativeHTTPStream",
        id,
        result: {
          status: incoming.statusCode ?? 500,
          statusText: incoming.statusMessage ?? "",
          url: message.request.url,
          headers: [["content-type", "text/event-stream"]],
        },
      });
    },
  );
  request.on("error", (error: Error) => {
    if (entries.has(id)) {
      errors.push(error);
      emit({ kind: "nativeHTTPError", id });
    }
  });
  entries.set(id, {
    close: () => {
      entries.get(id)?.incoming?.destroy();
      request.destroy();
    },
  });
  request.end();
}
function pullWire(
  message: Extract<Command, { kind: "pullHTTP" }>,
  entries: Map<number, WireEntry>,
  emit: Fixture["emit"],
  errors: Error[],
) {
  const iterator = entries.get(message.id)?.iterator;
  if (!iterator) throw new Error("Credit before real TLS headers.");
  void iterator
    .next()
    .then((value) => {
      if (!entries.has(message.id)) return;
      const body = value.done ? new Uint8Array() : new Uint8Array(value.value);
      expect(body.byteLength).toBeLessThanOrEqual(32768);
      emit(frame(message.id, message.sequence, body, !!value.done));
      if (value.done) entries.delete(message.id);
    })
    .catch((error: Error) => {
      if (entries.has(message.id)) {
        errors.push(error);
        emit({ kind: "nativeHTTPError", id: message.id });
      }
    });
}
export async function ownedTLS(f: Fixture) {
  const tls = certificate();
  const entered = deferred();
  const closed = deferred();
  const sockets = new Set<Duplex>();
  const server = createServer(tls, (request, response) => {
    expect(request.headers.accept).toBe("text/event-stream");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    if (request.url === "/finite") response.end("same peer still usable");
    else {
      request.socket.once("close", closed.resolve);
      response.write("data: ");
      entered.resolve();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z
    .object({
      port: z.number().int().min(1),
      address: z.literal("127.0.0.1"),
      family: z.literal("IPv4"),
    })
    .parse(server.address());
  const base = `https://127.0.0.1:${port}`;
  const entries = new Map<number, WireEntry>();
  const errors: Error[] = [];
  f.dispatch((message) => {
    if (message.kind === "nativeHTTPReady") {
      queueMicrotask(() => f.emit({ kind: "nativeHTTPReady", ready: true }));
      return;
    }
    if (message.kind === "cancelHTTP") {
      entries.get(message.id)?.close();
      entries.delete(message.id);
      return;
    }
    if (message.kind === "closeHTTP") {
      for (const entry of entries.values()) entry.close();
      entries.clear();
      return;
    }
    if (message.kind === "nativeHTTPStream")
      openWire(message, entries, tls.cert, f.emit, errors);
    else if (message.kind === "pullHTTP")
      pullWire(message, entries, f.emit, errors);
  });
  return {
    base,
    entered,
    closed,
    errors,
    close: async () => {
      f.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(tls.directory, { recursive: true, force: true });
    },
  };
}

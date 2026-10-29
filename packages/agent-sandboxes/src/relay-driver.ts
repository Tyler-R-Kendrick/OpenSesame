/**
 * A `BrowserDriver` that drives a browser behind the relay protocol.
 * Pure TypeScript with no Node imports: the same code runs in Node, in a
 * browser tab, or compiled to WASM, given a WebSocket-like transport.
 */

import type {
  BrowserDriver,
  Observation,
} from "@opensesame/cua-password-reset";
import {
  type RelayRequest,
  type RelayResponse,
  type RelayTransport,
  parseRelayResponse,
} from "./relay-protocol.js";

export class RelayBrowserDriver implements BrowserDriver {
  private sequence = 0;

  constructor(private readonly transport: RelayTransport) {}

  private async call(
    request: Omit<RelayRequest, "id">,
  ): Promise<RelayResponse & { ok: true }> {
    this.sequence += 1;
    const response = await this.transport({ ...request, id: this.sequence });
    if (!response.ok) throw new Error(`relay driver: ${response.error}`);
    return response;
  }

  async open(url: string): Promise<void> {
    await this.call({ method: "open", url });
  }

  async snapshot(): Promise<Observation> {
    const response = await this.call({ method: "snapshot" });
    if (!response.observation)
      throw new Error("relay driver: snapshot carried no observation");
    return response.observation;
  }

  async click(ref: string): Promise<void> {
    await this.call({ method: "click", ref });
  }

  async fill(ref: string, value: string): Promise<void> {
    await this.call({ method: "fill", ref, value });
  }

  async fillSecret(ref: string, value: string): Promise<void> {
    await this.call({ method: "fillSecret", ref, value });
  }

  async pageUrl(): Promise<string> {
    const response = await this.call({ method: "pageUrl" });
    return response.pageUrl ?? "";
  }

  async close(): Promise<void> {
    await this.call({ method: "close" });
  }
}

interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "error" | "close", listener: () => void): void;
}

/**
 * WebSocket transport for the relay protocol. Works with the global
 * `WebSocket` in browsers, Workers, WASM hosts, and Node ≥ 22. Requests
 * are serialized: the driver issues one command at a time, matching the
 * single-page session behind the relay.
 */
export function webSocketRelayTransport(
  socket: SocketLike,
  ready: Promise<void>,
): RelayTransport {
  let pending: {
    id: number;
    resolve: (response: RelayResponse) => void;
    reject: (error: Error) => void;
  } | null = null;
  let closed = false;
  const fail = () => {
    closed = true;
    const settle = pending;
    pending = null;
    settle?.reject(new Error("relay driver: connection closed"));
  };
  socket.addEventListener("close", fail);
  socket.addEventListener("error", fail);
  socket.addEventListener("message", (event) => {
    const settle = pending;
    if (!settle) return;
    const parsed = parseRelayResponse(String(event.data));
    if (!parsed) {
      pending = null;
      settle.reject(new Error("relay driver: undecodable response"));
      return;
    }
    if (parsed.id !== settle.id) return;
    pending = null;
    settle.resolve(parsed);
  });
  return async (request) => {
    await ready;
    if (closed) throw new Error("relay driver: connection closed");
    if (pending) throw new Error("relay driver: concurrent request");
    return new Promise<RelayResponse>((resolve, reject) => {
      pending = { id: request.id, resolve, reject };
      try {
        socket.send(JSON.stringify(request));
      } catch {
        pending = null;
        closed = true;
        reject(new Error("relay driver: connection closed"));
      }
    });
  };
}

export interface RelaySocketOptions {
  token: string;
}

/** Connect a relay driver to a `ws(s)://` relay endpoint. */
export function relayDriverOverWebSocket(
  url: string,
  options: RelaySocketOptions,
): RelayBrowserDriver {
  if (!options.token) throw new Error("relay driver: token is required");
  const endpoint = new URL(url);
  if (
    endpoint.username ||
    endpoint.password ||
    (endpoint.protocol !== "wss:" &&
      !(
        endpoint.protocol === "ws:" &&
        (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]")
      ))
  ) {
    throw new Error(
      "relay driver: remote relay requires wss and no URL credentials",
    );
  }
  const socket = new WebSocket(endpoint.href);
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      const onAuth = (event: MessageEvent) => {
        const parsed = parseRelayResponse(String(event.data));
        if (parsed && parsed.id !== 0) return;
        socket.removeEventListener("message", onAuth);
        if (parsed?.ok) resolve();
        else reject(new Error("relay driver: authentication refused"));
      };
      socket.addEventListener("message", onAuth);
      try {
        socket.send(JSON.stringify({ type: "auth", token: options.token }));
      } catch {
        reject(new Error("relay driver: connection failed"));
      }
    });
    socket.addEventListener("error", () =>
      reject(new Error("relay driver: connection failed")),
    );
    socket.addEventListener("close", () =>
      reject(new Error("relay driver: connection closed")),
    );
  });
  // The socket can close before the first driver call observes readiness.
  void ready.catch(() => {});
  // SAFETY: the global WebSocket implements the SocketLike surface used here (send/close/addEventListener), verified by the relay tests.
  return new RelayBrowserDriver(
    webSocketRelayTransport(socket as SocketLike, ready),
  );
}

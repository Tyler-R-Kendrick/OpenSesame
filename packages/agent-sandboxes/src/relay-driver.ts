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
  addEventListener(type: "error", listener: () => void): void;
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
    if (pending) throw new Error("relay driver: concurrent request");
    return new Promise<RelayResponse>((resolve, reject) => {
      pending = { id: request.id, resolve, reject };
      socket.send(JSON.stringify(request));
    });
  };
}

export interface RelaySocketOptions {
  token?: string;
}

/** Connect a relay driver to a `ws(s)://` relay endpoint. */
export function relayDriverOverWebSocket(
  url: string,
  options: RelaySocketOptions = {},
): RelayBrowserDriver {
  const socket = new WebSocket(url);
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      if (!options.token) {
        resolve();
        return;
      }
      const onAuth = (event: { data: unknown }) => {
        const parsed = parseRelayResponse(String(event.data));
        if (!parsed || parsed.id !== 0) {
          if (!parsed)
            reject(new Error("relay driver: authentication refused"));
          return;
        }
        if (parsed.ok) resolve();
        else reject(new Error("relay driver: authentication refused"));
      };
      socket.addEventListener("message", onAuth);
      socket.send(JSON.stringify({ type: "auth", token: options.token }));
    });
    socket.addEventListener("error", () =>
      reject(new Error("relay driver: connection failed")),
    );
  });
  // SAFETY: the global WebSocket implements the SocketLike surface used here (send/close/addEventListener), verified by the relay tests.
  return new RelayBrowserDriver(
    webSocketRelayTransport(socket as SocketLike, ready),
  );
}

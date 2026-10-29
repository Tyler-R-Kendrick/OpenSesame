/**
 * Node WebSocket client for CDP endpoints. Unlike the browser WebSocket
 * API, the `ws` client can send the provider's authorization header on
 * upgrade, which is how Cloudflare Browser Run authenticates CDP sockets.
 */

import WebSocket from "ws";
import { CdpConnection, type CdpSocket } from "./cdp-connection.js";

export interface ConnectCdpOptions {
  headers?: Readonly<Record<string, string>>;
}

export function connectCdp(
  url: string,
  options: ConnectCdpOptions = {},
): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: options.headers ?? {},
      followRedirects: false,
      handshakeTimeout: 15_000,
    });
    const socket: CdpSocket = {
      send: (data) => ws.send(data),
      close: () => ws.close(),
      onMessage: (listener) => {
        ws.on("message", (data) => listener(data.toString()));
      },
      onClose: (listener) => {
        ws.on("close", listener);
      },
    };
    ws.once("open", () => resolve(new CdpConnection(socket)));
    ws.on("error", () => reject(new Error("cdp: connection failed")));
  });
}

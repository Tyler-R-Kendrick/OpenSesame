/** Real TLS clients for the listener tests: `https.request` and raw `tls.connect`. */
import https from "node:https";
import tls from "node:tls";
import type { Issued } from "./pki.js";

export interface TlsResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  socket: tls.TLSSocket;
}

export interface TlsRequestOptions {
  port: number;
  ca: string;
  identity?: Issued;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  agent?: https.Agent;
}

export function tlsRequest(options: TlsRequestOptions): Promise<TlsResponse> {
  return new Promise((resolve, reject) => {
    let socket: tls.TLSSocket | undefined;
    const req = https.request(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers ?? {},
        ca: options.ca,
        ...(options.identity
          ? { cert: options.identity.certPem, key: options.identity.keyPem }
          : undefined),
        agent: options.agent ?? false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            // SAFETY: an https request's socket is the TLSSocket it ran on;
            // captured on assignment because a keep-alive agent detaches it
            // from the response before `end`.
            socket: socket as tls.TLSSocket,
          }),
        );
      },
    );
    req.on("socket", (assigned: tls.TLSSocket) => {
      socket = assigned;
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** A keep-alive agent pinned to one socket, for pooled-connection tests. */
export function pinnedAgent(ca: string, identity?: Issued): https.Agent {
  return new https.Agent({
    keepAlive: true,
    maxSockets: 1,
    ca,
    ...(identity
      ? { cert: identity.certPem, key: identity.keyPem }
      : undefined),
  });
}

export type HandshakeOutcome =
  | { kind: "connect_error"; code: string }
  | { kind: "post_connect"; outcome: string; protocol: string | null }
  | {
      kind: "http";
      statusLine: string;
      session: Buffer | undefined;
      reused: boolean;
    };

/**
 * Connect with raw TLS, then try one HTTP/1.1 request. Distinguishes a TLS
 * alert / close (no HTTP bytes ever arrive) from an HTTP response.
 */
export function rawHandshake(options: {
  port: number;
  ca: string;
  identity?: Issued;
  session?: Buffer;
}): Promise<HandshakeOutcome> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: "127.0.0.1",
        port: options.port,
        ca: options.ca,
        servername: "localhost",
        ...(options.identity
          ? { cert: options.identity.certPem, key: options.identity.keyPem }
          : undefined),
        ...(options.session ? { session: options.session } : undefined),
      },
      () => {
        socket.removeAllListeners("error");
        const finish = (outcome: HandshakeOutcome) => {
          socket.destroy();
          resolve(outcome);
        };
        socket.on("error", (error: NodeJS.ErrnoException) =>
          finish({
            kind: "post_connect",
            outcome: `error:${error.code ?? "unknown"}`,
            protocol: socket.getProtocol(),
          }),
        );
        socket.on("close", () =>
          finish({
            kind: "post_connect",
            outcome: "close-without-data",
            protocol: socket.getProtocol(),
          }),
        );
        socket.on("data", (data: Buffer) =>
          finish({
            kind: "http",
            statusLine: data.toString("utf8").split("\r\n")[0] ?? "",
            session: socket.getSession(),
            reused: socket.isSessionReused(),
          }),
        );
        socket.write(
          "GET /v1/health/live HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
      },
    );
    socket.on("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve({ kind: "connect_error", code: error.code ?? "unknown" });
    });
  });
}

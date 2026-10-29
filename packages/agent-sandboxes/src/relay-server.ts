/**
 * Reference relay server: hosts one real `BrowserDriver` behind the relay
 * protocol over an authenticated WebSocket. This is the process a remote
 * sandbox lane runs next to its browser (Boat runs it inside the sandbox;
 * tests run it in-process). The bearer token is checked on upgrade and
 * never logged; driver errors cross as messages, never as page content.
 */

import { type Server, createServer } from "node:http";
import type { BrowserDriver } from "@opensesame/cua-password-reset";
import { WebSocketServer } from "ws";
import {
  type RelayRequest,
  type RelayResponse,
  parseRelayFrame,
} from "./relay-protocol.js";

export interface RelayServerOptions {
  /** Port to bind; 0 picks an ephemeral port (tests). */
  port?: number;
  host?: string;
  /** Required bearer token for the WebSocket upgrade. */
  token: string;
  /** The browser this relay drives. One session per server. */
  driver: BrowserDriver;
}

export interface RunningRelayServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

type DispatchResult = Omit<Extract<RelayResponse, { ok: true }>, "id" | "ok">;

type DispatchHandler = (
  driver: BrowserDriver,
  request: RelayRequest,
) => Promise<DispatchResult>;

const HANDLERS = {
  open: async (driver, request) => {
    await driver.open(request.url ?? "");
    return {};
  },
  snapshot: async (driver) => ({ observation: await driver.snapshot() }),
  click: async (driver, request) => {
    await driver.click(request.ref ?? "");
    return {};
  },
  fill: async (driver, request) => {
    await driver.fill(request.ref ?? "", request.value ?? "");
    return {};
  },
  fillSecret: async (driver, request) => {
    await driver.fillSecret(request.ref ?? "", request.value ?? "");
    return {};
  },
  pageUrl: async (driver) => ({
    pageUrl: driver.pageUrl ? await driver.pageUrl() : "",
  }),
  close: async (driver) => {
    await driver.close?.();
    return {};
  },
} satisfies Record<RelayRequest["method"], DispatchHandler>;

async function dispatch(
  driver: BrowserDriver,
  request: RelayRequest,
): Promise<RelayResponse> {
  try {
    const result = await HANDLERS[request.method](driver, request);
    return { id: request.id, ok: true, ...result };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "driver failed",
    };
  }
}

export async function startRelayServer(
  options: RelayServerOptions,
): Promise<RunningRelayServer> {
  const server: Server = createServer((request, response) => {
    response.writeHead(404).end();
    void request;
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const headerAuthed =
      request.headers.authorization === `Bearer ${options.token}`;
    wss.handleUpgrade(request, socket, head, (ws) => {
      let authenticated = headerAuthed;
      ws.on("message", (data) => {
        void (async () => {
          const frame = parseRelayFrame(data.toString());
          if (!authenticated) {
            if (
              frame &&
              "auth" in frame &&
              frame.auth.token === options.token
            ) {
              authenticated = true;
              ws.send(JSON.stringify({ id: 0, ok: true }));
            } else {
              ws.send(
                JSON.stringify({ id: 0, ok: false, error: "unauthorized" }),
              );
              ws.close();
            }
            return;
          }
          if (!frame || !("request" in frame)) return;
          ws.send(
            JSON.stringify(await dispatch(options.driver, frame.request)),
          );
        })();
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    address instanceof Object && "port" in address ? address.port : 0;
  return {
    url: `ws://${options.host ?? "127.0.0.1"}:${port}`,
    port,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

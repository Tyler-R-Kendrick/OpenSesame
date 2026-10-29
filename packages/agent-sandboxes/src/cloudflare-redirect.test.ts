import { once } from "node:events";
import { type Server, createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { connectCdp } from "./cdp-node-socket.js";
import { CloudflareBrowserRunClient } from "./cloudflare-client.js";

const servers: Server[] = [];
const websocketServers: WebSocketServer[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const ws of websocketServers.splice(0)) {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("provider bearer redirects", () => {
  it("refuses an HTTP redirect and keeps the bearer away from the second endpoint", async () => {
    let reached = 0;
    const target = await listen(
      createServer((_request, response) => {
        reached += 1;
        response.writeHead(200).end();
      }),
    );
    const redirect = await listen(
      createServer((_request, response) => {
        response.writeHead(302, { location: `${target}/stolen` }).end();
      }),
    );
    const client = new CloudflareBrowserRunClient({
      accountId: "acct-1",
      apiToken: "test-bearer",
      baseUrl: redirect,
      allowInsecureLoopbackForTesting: true,
    });
    await expect(
      client.createSession(["accounts.example.test"]),
    ).rejects.toThrow("session allocation request failed");
    expect(reached).toBe(0);
  });

  it("refuses a WebSocket redirect and keeps the bearer away from the second endpoint", async () => {
    let reached = 0;
    const targetServer = createServer();
    targetServer.on("upgrade", (_request, socket) => {
      reached += 1;
      socket.destroy();
    });
    const target = await listen(targetServer);
    const redirectServer = createServer();
    redirectServer.on("upgrade", (_request, socket) => {
      socket.end(
        `HTTP/1.1 302 Found\r\nLocation: ${target.replace("http:", "ws:")}/stolen\r\nConnection: close\r\n\r\n`,
      );
    });
    const redirect = await listen(redirectServer);
    await expect(
      connectCdp(redirect.replace("http:", "ws:"), {
        headers: { authorization: "Bearer test-bearer" },
      }),
    ).rejects.toThrow("cdp: connection failed");
    expect(reached).toBe(0);
  });

  it("sends the bearer to the intended socket and opens a real WebSocket", async () => {
    let received = "";
    const server = createServer();
    const ws = new WebSocketServer({ noServer: true });
    websocketServers.push(ws);
    server.on("upgrade", (request, socket, head) => {
      received = request.headers.authorization ?? "";
      ws.handleUpgrade(request, socket, head, (connection) =>
        ws.emit("connection", connection, request),
      );
    });
    const base = await listen(server);
    const connection = await connectCdp(base.replace("http:", "ws:"), {
      headers: { authorization: "Bearer test-bearer" },
    });
    expect(received).toBe("Bearer test-bearer");
    connection.close();
  });
});

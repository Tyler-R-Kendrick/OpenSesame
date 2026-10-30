import { once } from "node:events";
import { type Server, createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import {
  CloudflareBrowserRunClient,
  CloudflareSessionCleanupError,
} from "./cloudflare-client.js";
import { CloudflareSandboxProvider } from "./cloudflare-provider.js";

const servers: Server[] = [];
const sockets: WebSocketServer[] = [];
const commandSchema = z.object({ id: z.number(), method: z.string() });
type DriverMode = "fail" | "wait" | "success";

async function fakeProvider(mode: DriverMode, deleteStatus = 200) {
  const server = createServer();
  const socketServer = new WebSocketServer({ server });
  servers.push(server);
  sockets.push(socketServer);
  let closed = 0;
  socketServer.on("connection", (socket) => {
    socket.on("close", () => {
      closed += 1;
    });
    socket.on("message", (bytes) => {
      const command = commandSchema.parse(JSON.parse(bytes.toString()));
      if (mode === "wait") return;
      if (mode === "fail") {
        socket.send(
          JSON.stringify({
            id: command.id,
            error: { message: "driver refused" },
          }),
        );
        return;
      }
      const result =
        command.method === "Target.createTarget"
          ? { targetId: "target-1" }
          : command.method === "Target.attachToTarget"
            ? { sessionId: "attached-1" }
            : {};
      socket.send(JSON.stringify({ id: command.id, result }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const baseUrl = `http://127.0.0.1:${port}`;
  const calls: string[] = [];
  const close = vi.spyOn(WebSocket.prototype, "close");
  let closeCallsAtDelete = 0;
  const client = new CloudflareBrowserRunClient({
    accountId: "acct-1",
    apiToken: "token-1",
    baseUrl,
    allowInsecureLoopbackForTesting: true,
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (init?.method === "DELETE")
        closeCallsAtDelete = close.mock.calls.length;
      return new Response(JSON.stringify({ sessionId: "sess-9" }), {
        status: init?.method === "DELETE" ? deleteStatus : 200,
      });
    },
  });
  return {
    provider: new CloudflareSandboxProvider({ client }),
    calls,
    closed: () => closed,
    closeCallsAtDelete: () => closeCallsAtDelete,
  };
}

afterEach(async () => {
  try {
    for (const socketServer of sockets.splice(0)) {
      for (const socket of socketServer.clients) socket.terminate();
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    }
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    vi.restoreAllMocks();
  }
});

describe("Cloudflare provider lifecycle", () => {
  it("closes an open socket and deletes the session when driver initialization fails", async () => {
    const { provider, calls, closed, closeCallsAtDelete } =
      await fakeProvider("fail");
    await expect(
      provider.allocate({ origin: "https://accounts.example.test" }),
    ).rejects.toThrow("driver refused");
    await vi.waitFor(() => expect(closed()).toBe(1));
    expect(closeCallsAtDelete()).toBe(1);
    expect(calls[1]).toMatch(/^DELETE .*\/sess-9$/u);
  });

  it("bounds initialization and closes the socket before session deletion", async () => {
    const { provider, calls, closed, closeCallsAtDelete } =
      await fakeProvider("wait");
    await expect(
      provider.allocate({ origin: "https://accounts.example.test" }),
    ).rejects.toThrow("initialization timed out");
    await vi.waitFor(() => expect(closed()).toBe(1));
    expect(closeCallsAtDelete()).toBe(1);
    expect(calls[1]).toMatch(/^DELETE .*\/sess-9$/u);
  }, 25_000);

  it("returns the validated session ID when cleanup fails", async () => {
    const { provider, closed, closeCallsAtDelete } = await fakeProvider(
      "fail",
      500,
    );
    const pending = provider.allocate({
      origin: "https://accounts.example.test",
    });
    await expect(pending).rejects.toBeInstanceOf(CloudflareSessionCleanupError);
    await expect(pending).rejects.toMatchObject({
      name: "CloudflareSessionCleanupError",
      sessionId: "sess-9",
    });
    await vi.waitFor(() => expect(closed()).toBe(1));
    expect(closeCallsAtDelete()).toBe(1);
  });

  it("attempts session deletion even if closing the browser throws", async () => {
    const { provider, calls } = await fakeProvider("success");
    const sandbox = await provider.allocate({
      origin: "https://accounts.example.test",
    });
    vi.spyOn(sandbox.browser, "close").mockRejectedValue(
      new Error("close failed"),
    );
    await expect(sandbox.close()).rejects.toThrow("close failed");
    expect(calls[1]).toMatch(/^DELETE .*\/sess-9$/u);
  });
});

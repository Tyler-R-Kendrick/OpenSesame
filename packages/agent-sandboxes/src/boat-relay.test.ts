import { createServer } from "node:http";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { BoatJsonValue } from "./boat-client.js";
import { BoatSandboxProvider } from "./boat-provider.js";

it("deletes the sandbox when an authenticated relay never answers close", async () => {
  const server = createServer((_request, response) =>
    response.writeHead(404).end(),
  );
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    let authenticated = false;
    socket.on("message", () => {
      if (!authenticated) {
        authenticated = true;
        socket.send(JSON.stringify({ id: 0, ok: true }));
      }
      // After auth, deliberately ignore every command, including close.
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(8787, "127.0.0.1", resolve),
  );
  try {
    let deleted = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      let body: BoatJsonValue;
      if (path === "/api/v1/sandboxes")
        body = {
          ok: true,
          sandbox: { id: "bx_23456789", state: "provisioning" },
        };
      else if (path.endsWith("/commands"))
        body = {
          ok: true,
          type: "command.started",
          success: true,
          processId: 1,
        };
      else if (path.endsWith("/host"))
        body = {
          ok: true,
          port: 8787,
          isProtected: true,
          access: "private",
          url: "http://127.0.0.1:8787",
        };
      else if (init?.method === "DELETE") {
        deleted = true;
        body = {
          ok: true,
          operation: {
            id: "bdop_0123456789abcdef0123456789abcdef",
            kind: "sandbox",
            targetId: "bx_23456789",
            status: "completed",
          },
        };
      } else
        body = {
          ok: true,
          sandbox: {
            id: "bx_23456789",
            state: "ready",
            url: "http://127.0.0.1:12345",
          },
        };
      return new Response(JSON.stringify(body), {
        status: init?.method === "DELETE" ? 202 : 200,
      });
    };
    const provider = new BoatSandboxProvider({
      origin: "http://127.0.0.1:12345",
      fetchImpl,
      apiToken: "boat-key",
      agentCommand: "agent",
      relayCloseTimeoutMs: 20,
    });
    const sandbox = await provider.allocate({
      origin: "https://accounts.example.test",
    });
    await sandbox.close();
    expect(deleted).toBe(true);
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

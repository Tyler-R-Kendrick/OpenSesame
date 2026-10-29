import { expect, it } from "vitest";
import type { BoatJsonValue } from "./boat-client.js";
import { BoatSandboxProvider } from "./boat-provider.js";

it("refuses an unrelated hosted port and cleans up before any relay connection", async () => {
  const { createServer } = await import("node:http");
  let sinkConnections = 0;
  const sink = createServer((_request, response) => {
    sinkConnections += 1;
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  try {
    const address = sink.address();
    if (!(address instanceof Object)) throw new Error("missing sink address");
    let deleted = false;
    const fakeFetch: typeof fetch = async (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      let body: BoatJsonValue;
      if (path === "/api/v1/sandboxes" && init?.method === "POST")
        body = {
          ok: true,
          sandbox: { id: "bx_23456789", state: "provisioning" },
        };
      else if (path.endsWith("/commands"))
        body = {
          ok: true,
          type: "command.started",
          success: true,
          processId: 7,
        };
      else if (path.endsWith("/host"))
        body = {
          ok: true,
          port: 8787,
          isProtected: true,
          access: "private",
          url: `http://127.0.0.1:${address.port}`,
        };
      else if (init?.method === "DELETE") {
        deleted = true;
        expect(new Headers(init.headers).get("x-ascii-confirm-delete")).toBe(
          "bx_23456789",
        );
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
            url: "https://machine.on.boat.dev",
          },
        };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const provider = new BoatSandboxProvider({
      origin: "http://127.0.0.1:12345",
      apiToken: "boat-key",
      agentCommand: "agent",
      fetchImpl: fakeFetch,
    });
    await expect(
      provider.allocate({ origin: "https://accounts.example.test" }),
    ).rejects.toThrow("invalid hosted relay destination");
    expect(sinkConnections).toBe(0);
    expect(deleted).toBe(true);
  } finally {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
  }
});

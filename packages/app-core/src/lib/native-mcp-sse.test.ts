import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { NativeMcpTransportPorts } from "./native-mcp-fetch.js";
import { NativeMcpSession } from "./native-mcp-protocol.js";
import type { NativeMcpBinding } from "./native-mcp-target.js";

const binding: NativeMcpBinding = {
  providerId: "cloudinary",
  fingerprint: "selected-cloudinary-target",
  endpoint: "https://asset-management.mcp.cloudinary.com/sse",
  resource: "https://asset-management.mcp.cloudinary.com",
  issuer: "https://auth.cloudinary.com",
  transport: "sse",
  ssePostEndpoint: "https://asset-management.mcp.cloudinary.com/messages",
};
const RpcSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
});
const sessions: NativeMcpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

function fixture(messagePath = "/messages") {
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const messages: string[] = [];
  const encode = (text: string) => new TextEncoder().encode(text);
  const ports: NativeMcpTransportPorts = {
    fetch: vi.fn(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(
                encode(
                  `event: endpoint\ndata: ${messagePath}?sessionId=issued-session\n\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const rpc = RpcSchema.parse(JSON.parse(await request.text()));
      messages.push(rpc.method);
      if (rpc.id !== undefined) {
        const result =
          rpc.method === "initialize"
            ? {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "Cloudinary MCP", version: "1" },
              }
            : {
                tools: [
                  { name: "list_assets", inputSchema: { type: "object" } },
                ],
              };
        stream?.enqueue(
          encode(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`,
          ),
        );
      }
      return new Response(null, { status: 202 });
    }),
    accessGrant: async () => null,
    assertCurrent: () => undefined,
    authorizationRequired: async () => undefined,
  };
  const session = new NativeMcpSession(binding, ports);
  sessions.push(session);
  return { session, messages, ports };
}

describe("native legacy SSE protocol", () => {
  it("uses server-issued sessions only on the provider-pinned POST endpoint", async () => {
    const { session, messages } = fixture();
    const result = await session.connect();
    expect(result.server.name).toBe("Cloudinary MCP");
    expect(result.tools.map((tool) => tool.name)).toEqual(["list_assets"]);
    expect(messages).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("does not forward requests to another same-origin path announced by the server", async () => {
    const { session, messages } = fixture("/different-api");
    await expect(session.connect()).rejects.toMatchObject({ code: "target" });
    expect(messages).toEqual([]);
  });
});

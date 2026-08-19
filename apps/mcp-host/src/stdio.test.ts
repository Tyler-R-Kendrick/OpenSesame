import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describe, expect, it } from "vitest";
import { connectStdio } from "./transports/stdio.js";

describe("connectStdio", () => {
  it("hands the server a stdio transport to connect", async () => {
    let connected: unknown;
    const server = {
      connect: async (transport: unknown) => {
        connected = transport;
      },
    } as unknown as McpServer;

    await connectStdio(server);

    expect(connected).toBeInstanceOf(StdioServerTransport);
  });
});

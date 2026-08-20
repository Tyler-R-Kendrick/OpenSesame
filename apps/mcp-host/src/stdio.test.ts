import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describe, expect, it } from "vitest";
import { connectStdio } from "./transports/stdio.js";
import { overlapCast, type BoundaryValue } from "@opensesame/os-domain";

describe("connectStdio", () => {
  it("hands the server a stdio transport to connect", async () => {
    let connected: unknown;
    const server = overlapCast({
      connect: async (transport: BoundaryValue) => {
        connected = transport;
      },
    });

    await connectStdio(server);

    expect(connected).toBeInstanceOf(StdioServerTransport);
  });
});

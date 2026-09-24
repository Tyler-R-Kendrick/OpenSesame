import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describe, expect, it, vi } from "vitest";
import { connectStdio } from "./transports/stdio.js";

describe("connectStdio", () => {
  it("hands the server a stdio transport to connect", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const connect = vi.spyOn(server, "connect").mockResolvedValue();

    await connectStdio(server);

    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]?.[0]).toBeInstanceOf(StdioServerTransport);
  });
});

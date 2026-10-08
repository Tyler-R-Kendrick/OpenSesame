import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerHostTools } from "./tools.js";

describe("mcp-host tool handlers", () => {
  it("registers no tools after Host API removal", () => {
    const names: string[] = [];
    const server = {
      tool: (name: string) => {
        names.push(name);
      },
    } as unknown as McpServer;
    registerHostTools(server);
    expect(names).toEqual([]);
  });
});

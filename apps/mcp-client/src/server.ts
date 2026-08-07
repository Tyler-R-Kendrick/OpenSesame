#!/usr/bin/env node
/**
 * Client MCP server — tools over Host api-client.
 * Does not expose materialize / getSecret (ADR 0005 / 0017).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createApiClient } from "@opensesame/api-client";
import { toolsManifest } from "./tools.js";

const hostUrl = process.env.OPENSESAME_HOST_API ?? "http://127.0.0.1:8787";

const server = new McpServer({
  name: "opensesame-mcp-client",
  version: "0.1.0",
});

server.tool("host_health", "Check Host API liveness", {}, async () => {
  const client = createApiClient({ baseUrl: hostUrl });
  const health = await client.health();
  const daemon = await client.probeDaemon();
  return {
    content: [{ type: "text", text: JSON.stringify({ health, daemon, tools: toolsManifest }) }],
  };
});

server.tool(
  "list_connections",
  "List ConnectionRefs from Host API",
  {},
  async () => {
    const client = createApiClient({ baseUrl: hostUrl });
    try {
      const data = await client.listConnections();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "invoke_l1",
  "Authorize and invoke L1 typed operation (never materialize)",
  {
    connectionRef: z.string(),
    operation: z.string(),
    resource: z.string(),
  },
  async ({ connectionRef, operation, resource }) => {
    const client = createApiClient({ baseUrl: hostUrl });
    try {
      const data = await client.invoke({
        connectionRef,
        operation,
        resource,
        invokeLevel: 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

#!/usr/bin/env node
/**
 * Host MCP — operator tools against Host API / daemon.
 * Never exposes getSecret or L3 materialize.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapServerWithTelemetry } from "./telemetry.js";
import { registerHostTools } from "./tools.js";
import { connectStdio } from "./transports/stdio.js";
import { connectStreamableHttp } from "./transports/streamable-http.js";

const server = new McpServer({
  name: "opensesame-mcp-host",
  version: "0.1.0",
});

// No-op unless OPENSESAME_TELEMETRY_KEY is set. Must run before
// registerHostTools() so every tool it registers gets wrapped.
wrapServerWithTelemetry(server);
registerHostTools(server);

const transportMode = process.env.OPENSESAME_MCP_TRANSPORT?.trim() || "stdio";
if (transportMode === "http") {
  await connectStreamableHttp(server);
} else if (transportMode === "stdio") {
  await connectStdio(server);
} else {
  throw new Error(`mcp_transport_unknown:${transportMode}`);
}

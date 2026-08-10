#!/usr/bin/env node
/**
 * Host MCP — operator tools against Host API / daemon.
 * Never exposes getSecret or L3 materialize.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapServerWithTelemetry } from "./telemetry.js";
import { registerHostTools } from "./tools.js";
import { connectStdio } from "./transports/stdio.js";

const server = new McpServer({
  name: "opensesame-mcp-host",
  version: "0.1.0",
});

// No-op unless OPENSESAME_TELEMETRY_KEY is set. Must run before
// registerHostTools() so every tool it registers gets wrapped.
wrapServerWithTelemetry(server);
registerHostTools(server);

await connectStdio(server);

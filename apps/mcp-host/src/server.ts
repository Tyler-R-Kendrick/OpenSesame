#!/usr/bin/env node
/**
 * Host MCP — operator tools against Host API / daemon.
 * Never exposes getSecret or L3 materialize.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHostTools } from "./tools.js";
import { connectStdio } from "./transports/stdio.js";

const server = new McpServer({
  name: "opensesame-mcp-host",
  version: "0.1.0",
});

registerHostTools(server);

await connectStdio(server);

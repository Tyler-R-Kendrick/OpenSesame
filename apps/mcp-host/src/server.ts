#!/usr/bin/env node
/**
 * Host MCP — operator tools against Host API / daemon.
 * Never exposes getSecret or L3 materialize.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { hostTools } from "./tools.js";

const hostUrl = process.env.OPENSESAME_HOST_API ?? "http://127.0.0.1:8787";
const daemonUrl = process.env.OPENSESAME_DAEMON_URL ?? "http://127.0.0.1:18790";

const server = new McpServer({
  name: "opensesame-mcp-host",
  version: "0.1.0",
});

server.tool("daemon_status", "Probe local host daemon", {}, async () => {
  try {
    const res = await fetch(`${daemonUrl.replace(/\/$/, "")}/v1/toolbar/status`);
    const body = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(body) }] };
  } catch (e) {
    return {
      content: [{ type: "text", text: `daemon_unavailable: ${e instanceof Error ? e.message : e}` }],
      isError: true,
    };
  }
});

server.tool("host_ready", "Host API readiness", {}, async () => {
  try {
    const res = await fetch(`${hostUrl.replace(/\/$/, "")}/health/ready`);
    const text = await res.text();
    return { content: [{ type: "text", text: JSON.stringify({ status: res.status, body: text, tools: hostTools }) }] };
  } catch (e) {
    return {
      content: [{ type: "text", text: `host_unavailable: ${e instanceof Error ? e.message : e}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

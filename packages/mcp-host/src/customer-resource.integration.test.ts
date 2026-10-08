import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isJsonObject, isNumber, overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { hostTools, registerHostTools } from "./tools.js";

function hostToolsFromModule(): readonly string[] {
  return hostTools;
}
import { connectStreamableHttp } from "./transports/streamable-http.js";

const HTTP_TOKEN = "local-mcp-test-token-0123456789abcdef";

function base(server: Server): string {
  const address = overlapCast(server.address());
  if (!isJsonObject(address) || !isNumber(address.port))
    throw new Error("expected a TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

it("streamable HTTP MCP advertises no Host API tools", async () => {
  const server = new McpServer({
    name: "empty-host-mcp",
    version: "0.0.0",
  });
  registerHostTools(server);
  const running = await connectStreamableHttp(server, {
    host: "127.0.0.1",
    port: 0,
    token: HTTP_TOKEN,
  });
  const client = new Client({ name: "integration-client", version: "0.0.0" });
  try {
    const httpTransport = new StreamableHTTPClientTransport(
      new URL(`${base(running.server)}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${HTTP_TOKEN}` } } },
    );
    await client.connect(
      overlapCast<StreamableHTTPClientTransport, Transport>(httpTransport),
    );
    expect(hostToolsFromModule()).toEqual([]);
  } finally {
    await client.close();
    await running.close();
  }
}, 30_000);

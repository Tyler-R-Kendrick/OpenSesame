import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  assertsNoSecretNames,
  mcpHostCatalog,
} from "@opensesame/capability-registry";
import { describe, expect, it } from "vitest";
import { assertsNoSecretTools, hostTools, registerHostTools } from "./tools.js";

describe("registry parity — mcp-host", () => {
  it("implements exactly the registry's mcp_host catalog", () => {
    expect(new Set([...hostTools])).toEqual(new Set(mcpHostCatalog()));
  });

  it("catalog passes both secret-name denylists", () => {
    expect(() => assertsNoSecretNames(hostTools)).not.toThrow();
    expect(() => assertsNoSecretTools(hostTools)).not.toThrow();
  });

  it("a connected server advertises exactly hostTools, nothing more", async () => {
    const server = new McpServer({ name: "parity-probe", version: "0.0.0" });
    registerHostTools(server);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "parity-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...hostTools].sort(),
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

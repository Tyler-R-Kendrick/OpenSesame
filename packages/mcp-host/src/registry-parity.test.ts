import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  assertsNoInteractionSettlementTool,
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

  it("exposes no tool that settles an interaction or mints a proof (ADR 0086)", () => {
    // Finding S12 / T-34: interaction settlement and proof generation are
    // human-only; a headless host tool must never carry either.
    expect(() => assertsNoInteractionSettlementTool(hostTools)).not.toThrow();
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

  it("the MCP skill lists exactly hostTools", () => {
    expect(skillTools("Host tools").sort()).toEqual([...hostTools].sort());
  });
});

/** The backticked tool names listed under `### <heading>` in the MCP skill. */
function skillTools(heading: string): string[] {
  const skill = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../skills/opensesame-mcps/SKILL.md",
    ),
    "utf8",
  );
  const start = skill.indexOf(`### ${heading}`);
  if (start < 0) throw new Error(`skill has no "${heading}" list`);
  const rest = skill.slice(start);
  const end = rest.indexOf("\n\n", rest.indexOf("\n- "));
  const list = end < 0 ? rest : rest.slice(0, end);
  return Array.from(list.matchAll(/^- `([a-z0-9_]+)`/gm), (m) => m[1] ?? "");
}

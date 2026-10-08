import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

it("stdio MCP advertises no Host sync tools after authority removal", async () => {
  const transport = new StdioClientTransport({
    command: "pnpm",
    args: ["exec", "tsx", "src/server.ts"],
    cwd: packageRoot,
  });
  const client = new Client({ name: "integration-client", version: "0.0.0" });
  try {
    await client.connect(transport);
    const resources = await client.listResources();
    expect(
      resources.resources.some((r) => r.name === "password-workflows"),
    ).toBe(true);
  } finally {
    await client.close();
  }
}, 30_000);

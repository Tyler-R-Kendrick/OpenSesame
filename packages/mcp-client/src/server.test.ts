import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer, modelError, modelText } from "./server.js";
import { assertsNoMaterializeTool, toolsManifest } from "./tools.js";

describe("mcp-client server", () => {
  it("exposes no Host API tools", () => {
    expect(toolsManifest).toEqual([]);
    expect(() => assertsNoMaterializeTool(toolsManifest)).not.toThrow();
  });

  it("advertises the password workflow resource", async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    const resources = await client.listResources();
    expect(
      resources.resources.some((r) => r.name === "password-workflows"),
    ).toBe(true);
    await client.close();
    await server.close();
  });

  it("modelText and modelError stay JSON-safe", () => {
    expect(modelText({ ok: true })).toEqual([
      { type: "text", text: expect.any(String) },
    ]);
    expect(modelError("x", new Error("y")).isError).toBe(true);
  });
});

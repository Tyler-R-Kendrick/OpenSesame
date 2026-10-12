import { describe, expect, it } from "vitest";
import { updateNativeConnector } from "./native-connector-store.js";
import {
  nativeMcpConnectorDriver,
  verifyNativeMcpConnector,
} from "./native-mcp-connectors.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import {
  NATIVE_MCP_GUIDE_MAX_BYTES,
  nativeMcpInputGuide,
} from "./native-mcp-guide.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import type { NativeMcpTool } from "./native-mcp-protocol.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

installNativeMcpConnectorTests();
const schema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    filter: {
      type: "object",
      properties: {
        published: { type: "boolean" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["published"],
      additionalProperties: false,
    },
  },
  required: ["query", "filter"],
  additionalProperties: false,
} satisfies NativeMcpTool["inputSchema"];

describe("actual MCP argument guidance", () => {
  it("exposes exact required names, nested types and constraints from actual SDK discovery", async () => {
    const provider = await mcpConnectorFixture({ inputSchema: schema });
    await verifyNativeMcpConnector(provider.id);
    const result = await nativeMcpConnectorDriver.invoke(
      provider.id,
      "mcp.tools.list",
      {},
    );
    expect(result.items[0]?.id).toBe("provider.search");
    expect(JSON.parse(result.items[0]?.inputSchema ?? "null")).toEqual(schema);
    expect(result.items[0]?.inputSchema).toContain('"published"');
    expect(provider.methods).toContain("tools/list");
  });
  it("refuses oversized actual guides rather than truncating or inventing argument rules", async () => {
    const actual = {
      ...schema,
      $comment: "x".repeat(NATIVE_MCP_GUIDE_MAX_BYTES),
    };
    const provider = await mcpConnectorFixture({ inputSchema: actual });
    await expect(verifyNativeMcpConnector(provider.id)).rejects.toMatchObject({
      code: "schema-limits",
    });
    expect(() => nativeMcpInputGuide(actual)).toThrow();
  });
  it("counts UTF-8 bytes rather than characters", () => {
    const actual = { ...schema, $comment: "🔒".repeat(9_000) };
    expect(JSON.stringify(actual).length).toBeLessThan(
      NATIVE_MCP_GUIDE_MAX_BYTES,
    );
    expect(() => nativeMcpInputGuide(actual)).toThrow();
  });
  it("never exposes a nested schema that reflects a known private credential", async () => {
    const secret = "known-private-mcp-credential";
    const provider = await mcpConnectorFixture({
      inputSchema: {
        ...schema,
        properties: {
          ...schema.properties,
          credential: { type: "string", description: secret },
        },
      },
    });
    const record = requireNativeMcpRecord(provider.id);
    await updateNativeConnector(
      provider.id,
      nativeOAuthGuard(record),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.credentials.mcp_client = JSON.stringify({
          client_id: "issued-public-client",
          client_secret: secret,
          token_endpoint_auth_method: "none",
        });
        return current;
      },
    );
    await verifyNativeMcpConnector(provider.id);
    await expect(
      nativeMcpConnectorDriver.invoke(provider.id, "mcp.tools.list", {}),
    ).rejects.toMatchObject({ code: "response" });
  });
});

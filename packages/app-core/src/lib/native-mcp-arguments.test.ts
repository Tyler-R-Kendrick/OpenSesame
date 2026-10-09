import { describe, expect, it } from "vitest";
import { nativeMcpConnectorDriver } from "./native-mcp-connectors.js";
import {
  advertisedTool,
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import { verifyNativeMcpConnector } from "./native-mcp-verification.js";

installNativeMcpConnectorTests();
async function verified() {
  const context = await mcpConnectorFixture();
  await verifyNativeMcpConnector(context.id);
  return context;
}

describe("MCP operator JSON arguments", () => {
  it.each(['{"query":', "[]", "null", '"search"'])(
    "explains invalid JSON objects without any provider HTTP for %s",
    async (arguments_) => {
      const context = await verified();
      const before = context.requests.length;
      await expect(
        nativeMcpConnectorDriver.invoke(
          context.id,
          `mcp.tool:${advertisedTool.name}`,
          { arguments: arguments_ },
        ),
      ).rejects.toMatchObject({
        code: "arguments",
        message: "Enter valid JSON object arguments for this tool.",
      });
      expect(context.requests).toHaveLength(before);
      expect(context.methods).not.toContain("tools/call");
    },
  );
  it("explains missing advertised fields without dispatching a tool mutation", async () => {
    const context = await verified();
    await expect(
      nativeMcpConnectorDriver.invoke(
        context.id,
        `mcp.tool:${advertisedTool.name}`,
        { arguments: "{}" },
      ),
    ).rejects.toMatchObject({
      code: "arguments",
      message:
        "Enter arguments that match this tool’s advertised input schema.",
    });
    expect(context.methods).not.toContain("tools/call");
  });
  it("preserves the separate unknown advertised tool refusal", async () => {
    const context = await verified();
    await expect(
      nativeMcpConnectorDriver.invoke(context.id, "mcp.tool:invented", {
        arguments: "{}",
      }),
    ).rejects.toMatchObject({
      code: "tool",
      message: "Select a tool advertised by this MCP server.",
    });
    expect(context.methods).not.toContain("tools/call");
  });
});

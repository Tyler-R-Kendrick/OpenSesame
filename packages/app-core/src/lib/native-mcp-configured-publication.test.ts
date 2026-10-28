import { expect, it } from "vitest";
import { subscribeDeviceRows } from "./device-connector-records.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";
import { configuredMcpCredentials } from "./native-mcp-configured-config.js";
import { configuredMcpFixture } from "./native-mcp-configured.test-support.js";

it("preserves a published configured-MCP credential when a committed-row listener throws", async () => {
  const f = await configuredMcpFixture();
  try {
    const first = await f.driver.configure(f.input);
    const stop = subscribeDeviceRows(() => {
      throw new Error("Injected post-publication listener failure");
    });
    try {
      await expect(
        f.driver.configure({
          ...f.input,
          connectionId: first.connectionId,
          revision: first.revision,
          credentials: { mcp_token: "replacement-mcp-credential" },
        }),
      ).rejects.toThrow("Injected post-publication listener failure");
    } finally {
      stop();
    }
    const record = loadNativeConnectorRecord(first.connectionId);
    if (!record) throw new Error("Expected the published MCP connection");
    const held = configuredMcpCredentials(
      record.configuration,
      record.privateState.credentials,
      f.owner,
    );
    expect(held.fields.get("mcpToken")).toBe("replacement-mcp-credential");
  } finally {
    await f.close();
  }
});

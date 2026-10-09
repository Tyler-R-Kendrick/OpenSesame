import { describe, expect, it, vi } from "vitest";
import { readNativeConnector } from "./native-connector-store.js";
import {
  bindNativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { beginNativeMcpAuthorization } from "./native-mcp-authorization.js";
import { createNativeMcpConnectorDriver } from "./native-mcp-connectors.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";

installNativeMcpConnectorTests();
describe("MCP activated runtime boundaries", () => {
  it("does not let a retained old driver borrow a fresh connector activation", async () => {
    const old = await mcpConnectorFixture();
    const driver = createNativeMcpConnectorDriver(nativeProviderTransport());
    old.disable();
    const freshFetch = vi.fn(async () => new Response("{}"));
    const release = bindNativeProviderTransport({
      fetch: freshFetch,
      assertCurrent: () => undefined,
    });
    try {
      await expect(driver.configure(old.draft)).rejects.toThrow();
      await expect(driver.verify(old.id)).rejects.toThrow();
      await expect(driver.authorize?.(old.id)).rejects.toThrow();
      await expect(
        driver.invoke(old.id, "mcp.tools.list", {}),
      ).rejects.toThrow();
      expect(old.requests).toHaveLength(0);
      expect(freshFetch).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
  it("does not journal a fictitious DCR mutation when admission metadata failed before dispatch", async () => {
    const context = await mcpConnectorFixture({ metadataFailure: true });
    await expect(beginNativeMcpAuthorization(context.id)).rejects.toThrow();
    expect(context.requests.every((request) => request.method === "GET")).toBe(
      true,
    );
    expect(requireNativeMcpRecord(context.id).privateState.recovery).toEqual(
      [],
    );
    expect(readNativeConnector(context.id)?.status).toBe("configuration");
    expect(context.navigate).not.toHaveBeenCalled();
  });
});

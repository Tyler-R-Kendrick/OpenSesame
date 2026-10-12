import { describe, expect, it, vi } from "vitest";
import { updateNativeConnector } from "./native-connector-store.js";
import { beginNativeMcpAuthorization } from "./native-mcp-authorization.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

installNativeMcpConnectorTests();

describe("MCP popup cancellation", () => {
  it("allows a fresh consent after cancellation without exchanging a token", async () => {
    const fixture = await mcpConnectorFixture();
    const authorize = vi.fn(async () => {
      throw new Error("Sign-in cancelled");
    });
    const release = bindNativeOAuthBrowserPort({
      redirectUri: "https://self-host.example.org/auth/native-connector.html",
      navigate: vi.fn(),
      scrubCallback: vi.fn(),
      authorize,
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(beginNativeMcpAuthorization(fixture.id)).rejects.toThrow(
          "Sign-in cancelled",
        );
        expect(requireNativeMcpRecord(fixture.id).privateState.pending).toEqual(
          {},
        );
      }
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(requireNativeMcpRecord(fixture.id).privateState.grants).toEqual(
        {},
      );
      expect(
        fixture.requests.some((request) => request.url.endsWith("/token")),
      ).toBe(false);
    } finally {
      release();
    }
  });

  it("does not discard a consent that another attempt replaced", async () => {
    const fixture = await mcpConnectorFixture();
    const replacement = "b".repeat(64);
    const release = bindNativeOAuthBrowserPort({
      redirectUri: "https://self-host.example.org/auth/native-connector.html",
      navigate: vi.fn(),
      scrubCallback: vi.fn(),
      authorize: async () => {
        const record = requireNativeMcpRecord(fixture.id);
        await updateNativeConnector(
          fixture.id,
          nativeOAuthGuard(record),
          MCP_CLASSIFICATION,
          (current) => {
            const pending = current.privateState.pending.user;
            if (!pending) throw new Error("Expected sealed consent");
            current.privateState.pending.user = {
              ...pending,
              state: replacement,
            };
            return current;
          },
        );
        throw new Error("Old popup cancelled");
      },
    });
    try {
      await expect(beginNativeMcpAuthorization(fixture.id)).rejects.toThrow(
        "Old popup cancelled",
      );
      expect(
        requireNativeMcpRecord(fixture.id).privateState.pending.user?.state,
      ).toBe(replacement);
    } finally {
      release();
    }
  });
});

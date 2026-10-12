import { describe, expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { nativeAnswers } from "./native-api.test-support.js";
import { bindNativeBrowserPolicyOrigin } from "./native-browser-policy.js";
import { removeNativeConnectorWithCleanup } from "./native-connector-lifecycle.js";
import { readNativeConnector } from "./native-connector-store.js";
import {
  beginNativeMcpAuthorization,
  finishNativeMcpAuthorization,
} from "./native-mcp-authorization.js";
import {
  nativeMcpCompiledUnavailableReason,
  nativeMcpUnavailableReason,
} from "./native-mcp-availability.js";
import { configureNativeMcpConnector } from "./native-mcp-config.js";
import { createNativeMcpConnectorDriver } from "./native-mcp-connectors.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import {
  invokeNativeMcpTool,
  listNativeMcpTools,
} from "./native-mcp-operations.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { verifyNativeMcpConnector } from "./native-mcp-verification.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";

const AUDITED_ORIGIN = "https://tyler-r-kendrick.github.io";
installNativeMcpConnectorTests();

function callback(id: string): string {
  const pending = requireNativeMcpRecord(id).privateState.pending.user;
  if (!pending) throw new Error("Expected sealed fixture consent");
  return `?native_state=${pending.state}&native_code=fixture-code`;
}

describe("MCP browser admission before provider mutation", () => {
  it("seals consent before an approved browser auth round trip and completes it in the originating session", async () => {
    const context = await mcpConnectorFixture();
    let opened = 0;
    const release = bindNativeOAuthBrowserPort({
      redirectUri: "https://self-host.example.org/auth/native-connector.html",
      navigate: () => {
        throw new Error("The approved browser port owns this round trip");
      },
      scrubCallback: () => undefined,
      authorize: async (url, expected) => {
        opened++;
        const pending = requireNativeMcpRecord(context.id).privateState.pending
          .user;
        expect(pending.state).toBe(expected.state);
        expect(pending.expiresAt).toBe(expected.expiresAt);
        expect(new URL(url).searchParams.get("state")).toBe(expected.state);
        expect(
          context.requests.some((request) => request.url.includes("register")),
        ).toBe(true);
        return `?native_state=${expected.state}&native_code=fixture-returned-code`;
      },
    });
    try {
      await beginNativeMcpAuthorization(context.id);
      expect(opened).toBe(1);
      expect(readNativeConnector(context.id)?.status).toBe("connected");
      expect(requireNativeMcpRecord(context.id).privateState.pending).toEqual(
        {},
      );
      expect(context.methods).toContain("initialize");
      expect(context.methods).toContain("tools/list");
    } finally {
      release();
    }
  });
  it("blocks configuration before HTTP or saving a local record", async () => {
    const answers = nativeAnswers();
    await expect(
      configureNativeMcpConnector(
        {
          providerId: "adobe",
          displayName: "Adobe",
          method: "mcp",
          parameters: {},
          credentials: {},
          requestedScopes: {},
          targetIds: {},
        },
        answers.transport,
      ),
    ).rejects.toThrow(/required protocol header/);
    expect(answers.fetch).not.toHaveBeenCalled();
    expect(readDeviceRows()).toEqual([]);
  });

  it("keeps compiled support for cleanup while browser authorization is denied", () => {
    const driver = createNativeMcpConnectorDriver(nativeAnswers().transport);
    expect(nativeMcpCompiledUnavailableReason("adobe")).toBeNull();
    expect(nativeMcpUnavailableReason("adobe")).toMatch(
      /required protocol header/,
    );
    expect(driver.supports("adobe")).toBe(true);
    expect(driver.cleanup.cleanup).toBeTypeOf("function");
  });

  it("does not register a client or change a draft on a currently denied origin", async () => {
    const context = await mcpConnectorFixture();
    const before = requireNativeMcpRecord(context.id);
    const release = bindNativeBrowserPolicyOrigin(() => AUDITED_ORIGIN);
    try {
      await expect(beginNativeMcpAuthorization(context.id)).rejects.toThrow(
        /required protocol header/,
      );
      expect(context.requests).toEqual([]);
      expect(requireNativeMcpRecord(context.id)).toEqual(before);
    } finally {
      release();
    }
  });

  it("refuses callback exchange without consuming sealed consent or making a token request", async () => {
    const context = await mcpConnectorFixture();
    await beginNativeMcpAuthorization(context.id);
    const search = callback(context.id);
    const before = requireNativeMcpRecord(context.id);
    const requestCount = context.requests.length;
    const release = bindNativeBrowserPolicyOrigin(() => AUDITED_ORIGIN);
    try {
      await expect(finishNativeMcpAuthorization(search)).rejects.toThrow(
        /required protocol header/,
      );
      expect(requireNativeMcpRecord(context.id)).toEqual(before);
      expect(context.requests).toHaveLength(requestCount);
    } finally {
      release();
    }
  });

  it("blocks verification and tools while retaining the issued grant for actual cleanup", async () => {
    const context = await mcpConnectorFixture({ management: true });
    await beginNativeMcpAuthorization(context.id);
    await finishNativeMcpAuthorization(callback(context.id));
    const requestCount = context.requests.length;
    const release = bindNativeBrowserPolicyOrigin(() => AUDITED_ORIGIN);
    try {
      await expect(verifyNativeMcpConnector(context.id)).rejects.toThrow(
        /required protocol header/,
      );
      await expect(listNativeMcpTools(context.id)).rejects.toThrow(
        /required protocol header/,
      );
      await expect(
        invokeNativeMcpTool(context.id, "provider.search", { query: "test" }),
      ).rejects.toThrow(/required protocol header/);
      expect(context.requests).toHaveLength(requestCount);
      const outcome = await removeNativeConnectorWithCleanup(context.id);
      expect(outcome).toBeDefined();
      const cleanupRequests = context.requests.slice(requestCount);
      expect(
        cleanupRequests.some((request) => request.method === "DELETE"),
      ).toBe(true);
      expect(readDeviceRows()).toEqual([]);
    } finally {
      release();
    }
  });
});

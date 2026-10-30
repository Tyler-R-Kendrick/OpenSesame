import { describe, expect, it, vi } from "vitest";
import { kvSeams } from "./kv.js";
import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { nativeMcpRevocationInstructions } from "./native-mcp-attestation.js";
import {
  beginNativeMcpAuthorization,
  finishNativeMcpAuthorization,
} from "./native-mcp-authorization.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import { MCP_CLASSIFICATION } from "./native-mcp-profile.js";
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { verifyNativeMcpConnector } from "./native-mcp-verification.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

installNativeMcpConnectorTests();
function callback(id: string): string {
  const pending = requireNativeMcpRecord(id).privateState.pending.user;
  if (!pending) throw new Error("Expected sealed pending consent");
  return `?native_state=${pending.state}&native_code=actual-provider-code`;
}
async function authorized(
  options: Parameters<typeof mcpConnectorFixture>[0] = {},
) {
  const context = await mcpConnectorFixture(options);
  await beginNativeMcpAuthorization(context.id);
  await finishNativeMcpAuthorization(callback(context.id));
  return context;
}

describe("native MCP refresh recovery", () => {
  it("retains an under-scoped rotated grant for cleanup without contacting MCP", async () => {
    const token = {
      access_token: "initial-access",
      refresh_token: "initial-refresh",
      token_type: "Bearer",
      scope: "openid AdobeID",
      expires_in: 3600,
    };
    const context = await authorized({
      management: true,
      requestedScopes: ["openid", "AdobeID"],
      token,
    });
    const initial = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.grants.user.expiresAt = 1;
        current.runtime.grants[0].expiresAt = 1;
        return current;
      },
    );
    token.access_token = "replacement-access";
    token.refresh_token = "replacement-refresh";
    token.scope = "openid";
    context.methods.splice(0);
    await expect(verifyNativeMcpConnector(context.id)).rejects.toMatchObject({
      code: "permission",
    });
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.grants).toEqual({});
    expect(record.privateState.recovery[0]).toMatchObject({
      credentials: { phase: "verify" },
      grant: {
        accessToken: "replacement-access",
        refreshToken: "replacement-refresh",
        scopes: ["openid"],
      },
    });
    expect(readNativeConnector(context.id)?.status).toBe("cleanup");
    expect(context.methods).toEqual([]);
    await retryNativeConnectorCleanup(context.id);
    const revoked = context.requests.filter((request) =>
      request.url.endsWith("/ims/revoke"),
    );
    const bodies = await Promise.all(
      revoked.map(async (request) => new URLSearchParams(await request.text())),
    );
    expect(bodies.map((body) => body.get("token"))).toEqual(
      expect.arrayContaining(["replacement-refresh", "replacement-access"]),
    );
  });

  it("keeps the old grant and requests reauthorization for invalid refresh", async () => {
    const options = { tokenFailure: false };
    const context = await authorized(options);
    const initial = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.grants.user.expiresAt = 1;
        current.runtime.grants[0].expiresAt = 1;
        return current;
      },
    );
    options.tokenFailure = true;
    await expect(verifyNativeMcpConnector(context.id)).rejects.toMatchObject({
      code: "authorization",
      oauthError: "invalid_grant",
    });
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.recovery).toEqual([]);
    expect(record.privateState.grants.user.refreshToken).toBe(
      "rotated-refresh",
    );
    expect(record.runtime.grants[0].needsReauth).toBe(true);
  });

  it("keeps the old grant after a refresh failure before token issuance", async () => {
    const options = { metadataFailure: false };
    const context = await authorized(options);
    const initial = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.grants.user.expiresAt = 1;
        current.runtime.grants[0].expiresAt = 1;
        return current;
      },
    );
    options.metadataFailure = true;
    await expect(verifyNativeMcpConnector(context.id)).rejects.toThrow();
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.recovery).toEqual([]);
    expect(record.privateState.grants.user.refreshToken).toBe(
      "rotated-refresh",
    );
    expect(record.privateState.verification).toBeNull();
  });

  it("retains a recovery obligation when a refresh response is lost after submission", async () => {
    let loseResponse = false;
    const context = await authorized({
      onToken: () => {
        if (loseResponse) throw new Error("response lost after issuance");
      },
    });
    const initial = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.grants.user.expiresAt = 1;
        current.runtime.grants[0].expiresAt = 1;
        return current;
      },
    );
    loseResponse = true;
    await expect(verifyNativeMcpConnector(context.id)).rejects.toThrow();
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.recovery[0]?.credentials?.phase).toBe("refresh");
    expect(record.privateState.grants.user.refreshToken).toBe(
      "rotated-refresh",
    );
    expect(readNativeConnector(context.id)?.status).toBe("cleanup");
    expect(
      (
        await nativeMcpRevocationInstructions(
          context.id,
          record.privateState.recovery[0].id,
        )
      ).canConfirm,
    ).toBe(false);
  });

  it("retries sealing a rotated pair after a transient storage failure before cleanup", async () => {
    const token = {
      access_token: "initial-access",
      refresh_token: "initial-refresh",
      token_type: "Bearer",
      scope: "openid AdobeID",
      expires_in: 3600,
    };
    let fail = false;
    const context = await authorized({
      management: true,
      requestedScopes: ["openid", "AdobeID"],
      token,
      onToken: () => {
        if (fail)
          vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
            new Error("storage unavailable"),
          );
      },
    });
    const initial = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.grants.user.expiresAt = 1;
        current.runtime.grants[0].expiresAt = 1;
        return current;
      },
    );
    token.access_token = "replacement-access";
    token.refresh_token = "replacement-refresh";
    fail = true;
    await expect(verifyNativeMcpConnector(context.id)).rejects.toThrow();
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.recovery[0]?.credentials?.phase).toBe("refresh");
    expect(record.privateState.grants.user.refreshToken).toBe(
      "initial-refresh",
    );
    fail = false;
    await retryNativeConnectorCleanup(context.id);
    const revoked = context.requests.filter((request) =>
      request.url.endsWith("/ims/revoke"),
    );
    const bodies = await Promise.all(
      revoked.map(async (request) => new URLSearchParams(await request.text())),
    );
    expect(bodies.map((body) => body.get("token"))).toEqual(
      expect.arrayContaining(["replacement-refresh", "replacement-access"]),
    );
  });

  it.each(["excess scopes", "invalid refresh token"] as const)(
    "retains the valid rotated access token on %s without MCP use",
    async (malformed) => {
      const token = {
        access_token: "initial-access",
        refresh_token: "initial-refresh",
        token_type: "Bearer",
        scope: "openid AdobeID",
        expires_in: 3600,
      };
      const context = await authorized({
        requestedScopes: ["openid", "AdobeID"],
        token,
      });
      const initial = requireNativeMcpRecord(context.id);
      await updateNativeConnector(
        context.id,
        nativeOAuthGuard(initial),
        MCP_CLASSIFICATION,
        (current) => {
          current.privateState.grants.user.expiresAt = 1;
          current.runtime.grants[0].expiresAt = 1;
          return current;
        },
      );
      token.access_token = "replacement-access";
      token.refresh_token =
        malformed === "invalid refresh token" ? "" : "replacement-refresh";
      token.scope =
        malformed === "excess scopes"
          ? Array.from({ length: 257 }, (_, i) => `scope-${i}`).join(" ")
          : "openid AdobeID";
      context.methods.splice(0);
      await expect(verifyNativeMcpConnector(context.id)).rejects.toMatchObject({
        code: "authorization",
      });
      const record = requireNativeMcpRecord(context.id);
      expect(record.privateState.grants).toEqual({});
      expect(record.privateState.recovery[0]?.grant).toMatchObject({
        accessToken: "replacement-access",
        scopes: null,
      });
      expect(context.methods).toEqual([]);
      expect(readNativeConnector(context.id)?.status).toBe("cleanup");
    },
  );

  it("preserves and revokes both the refresh-only replacement and previously sealed pair", async () => {
    const token = {
      access_token: "previous-access",
      refresh_token: "previous-refresh",
      token_type: "Bearer",
      scope: "openid",
      expires_in: 3600,
    };
    const context = await authorized({
      management: true,
      requestedScopes: ["openid"],
      token,
    });
    const initial = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.grants.user.expiresAt = 1;
        current.runtime.grants[0].expiresAt = 1;
        return current;
      },
    );
    token.access_token = "";
    token.refresh_token = "new-partial-refresh";
    context.methods.splice(0);
    await expect(verifyNativeMcpConnector(context.id)).rejects.toMatchObject({
      code: "authorization",
    });
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.grants).toEqual({});
    expect(record.privateState.recovery[0]).toMatchObject({
      credentials: {
        phase: "partial-refresh",
        partial_refresh_token: "new-partial-refresh",
      },
      grant: {
        accessToken: "previous-access",
        refreshToken: "previous-refresh",
      },
    });
    expect(context.methods).toEqual([]);
    await retryNativeConnectorCleanup(context.id);
    const revoked = context.requests.filter((request) =>
      request.url.endsWith("/ims/revoke"),
    );
    const bodies = await Promise.all(
      revoked.map(async (request) => new URLSearchParams(await request.text())),
    );
    expect(bodies.map((body) => body.get("token"))).toEqual(
      expect.arrayContaining([
        "new-partial-refresh",
        "previous-refresh",
        "previous-access",
      ]),
    );
  });

  it("retries a refresh-only receipt after transient durable sealing failure", async () => {
    let fail = true;
    const context = await mcpConnectorFixture({
      management: true,
      requestedScopes: ["openid"],
      token: {
        access_token: "",
        refresh_token: "partial-retry-secret",
        token_type: "Bearer",
      },
      onToken: () => {
        if (fail)
          vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
            new Error("storage unavailable"),
          );
      },
    });
    await beginNativeMcpAuthorization(context.id);
    await expect(
      finishNativeMcpAuthorization(callback(context.id)),
    ).rejects.toThrow();
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery[0]?.credentials
        ?.phase,
    ).toBe("exchange");
    fail = false;
    await retryNativeConnectorCleanup(context.id);
    const revoked = context.requests.filter((request) =>
      request.url.endsWith("/ims/revoke"),
    );
    const bodies = await Promise.all(
      revoked.map(async (request) => new URLSearchParams(await request.text())),
    );
    expect(bodies.map((body) => body.get("token"))).toEqual([
      "partial-retry-secret",
    ]);
  });
});

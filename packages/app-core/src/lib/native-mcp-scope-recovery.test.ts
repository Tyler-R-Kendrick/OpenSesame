import { describe, expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  beginNativeMcpAuthorization,
  finishNativeMcpAuthorization,
} from "./native-mcp-authorization.js";
import {
  installNativeMcpConnectorTests,
  mcpConnectorFixture,
} from "./native-mcp-connectors.test-support.js";
import { listNativeMcpTools } from "./native-mcp-operations.js";
import {
  releaseNativeMcpPartialReservation,
  reserveNativeMcpPartialRefresh,
} from "./native-mcp-partial-refresh.js";
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

describe("native MCP scope and partial authorization recovery", () => {
  it("does not consume a callback when partial-receipt capacity is unavailable", async () => {
    const context = await mcpConnectorFixture();
    await beginNativeMcpAuthorization(context.id);
    const search = callback(context.id);
    const before = context.requests.length;
    for (let index = 0; index < 64; index += 1)
      reserveNativeMcpPartialRefresh(
        `reserved-${index}`,
        `intent-${index}`,
        "a".repeat(64),
      );
    try {
      await expect(finishNativeMcpAuthorization(search)).rejects.toMatchObject({
        code: "storage",
      });
      expect(
        requireNativeMcpRecord(context.id).privateState.pending.user,
      ).toBeDefined();
      expect(requireNativeMcpRecord(context.id).privateState.recovery).toEqual(
        [],
      );
      expect(context.requests).toHaveLength(before);
    } finally {
      for (let index = 0; index < 64; index += 1)
        releaseNativeMcpPartialReservation(
          `reserved-${index}`,
          `intent-${index}`,
        );
    }
    expect((await finishNativeMcpAuthorization(search)).status).toBe(
      "connected",
    );
  });
  it("retains an under-scoped initial grant without sending it to the MCP resource", async () => {
    const context = await mcpConnectorFixture({
      requestedScopes: ["openid", "AdobeID"],
      token: {
        access_token: "under-scoped-access",
        refresh_token: "under-scoped-refresh",
        token_type: "Bearer",
        scope: "openid",
      },
    });
    await beginNativeMcpAuthorization(context.id);
    await expect(
      finishNativeMcpAuthorization(callback(context.id)),
    ).rejects.toMatchObject({ code: "permission" });
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.grants).toEqual({});
    expect(record.privateState.recovery[0]?.grant).toMatchObject({
      accessToken: "under-scoped-access",
      refreshToken: "under-scoped-refresh",
      scopes: ["openid"],
    });
    expect(context.methods).toEqual([]);
    expect(readNativeConnector(context.id)?.status).toBe("cleanup");
  });

  it("rejects a previously saved under-scoped grant before MCP verification or use", async () => {
    const context = await authorized({
      requestedScopes: ["openid", "AdobeID"],
      token: {
        access_token: "issued-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
        scope: "openid AdobeID",
      },
    });
    const record = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(record),
      MCP_CLASSIFICATION,
      (current) => {
        current.privateState.grants.user.scopes = ["openid"];
        current.runtime.grants[0].grantedScopes = ["openid"];
        return current;
      },
    );
    context.methods.splice(0);
    await expect(verifyNativeMcpConnector(context.id)).rejects.toMatchObject({
      code: "permission",
    });
    await expect(listNativeMcpTools(context.id)).rejects.toMatchObject({
      code: "authorization",
    });
    expect(context.methods).toEqual([]);
    const current = requireNativeMcpRecord(context.id);
    await updateNativeConnector(
      context.id,
      nativeOAuthGuard(current),
      MCP_CLASSIFICATION,
      (updated) => {
        updated.privateState.grants.user.expiresAt = 1;
        updated.runtime.grants[0].expiresAt = 1;
        return updated;
      },
    );
    // A refresh may restore the missing permission. It is sent only to the
    // pinned issuer; the replacement must pass the guard before MCP use.
    const view = await verifyNativeMcpConnector(context.id);
    expect(view.status).toBe("connected");
    expect(context.methods).toContain("initialize");
  });

  it("accepts provider-managed unknown scopes without inventing granted scopes", async () => {
    const context = await authorized({
      requestedScopes: ["openid", "AdobeID"],
      token: {
        access_token: "issued-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
      },
    });
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.grants.user.scopes).toBeNull();
    expect(record.runtime.grants[0]).toMatchObject({
      permissionState: "provider-managed",
      grantedScopes: [],
    });
    expect(context.methods).toContain("initialize");
  });

  it("rejects an explicitly empty granted scope list before MCP use", async () => {
    const context = await mcpConnectorFixture({
      requestedScopes: ["openid"],
      token: {
        access_token: "empty-scope-token",
        token_type: "Bearer",
        scope: "",
      },
    });
    await beginNativeMcpAuthorization(context.id);
    await expect(
      finishNativeMcpAuthorization(callback(context.id)),
    ).rejects.toMatchObject({ code: "permission" });
    expect(context.methods).toEqual([]);
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery[0]?.grant
        ?.scopes,
    ).toEqual([]);
  });

  it.each(["excess scopes", "invalid refresh token"] as const)(
    "retains the valid initial access token on %s without MCP use",
    async (malformed) => {
      const excessive = Array.from(
        { length: 257 },
        (_, i) => `scope-${i}`,
      ).join(" ");
      const context = await mcpConnectorFixture({
        requestedScopes: ["openid"],
        token: {
          access_token: "issued-access",
          refresh_token:
            malformed === "invalid refresh token" ? "" : "issued-refresh",
          token_type: "Bearer",
          scope: malformed === "excess scopes" ? excessive : "openid",
        },
      });
      await beginNativeMcpAuthorization(context.id);
      await expect(
        finishNativeMcpAuthorization(callback(context.id)),
      ).rejects.toMatchObject({ code: "authorization" });
      const record = requireNativeMcpRecord(context.id);
      expect(record.privateState.grants).toEqual({});
      expect(record.privateState.recovery[0]?.grant).toMatchObject({
        accessToken: "issued-access",
        scopes: null,
      });
      expect(context.methods).toEqual([]);
      expect(readNativeConnector(context.id)?.status).toBe("cleanup");
    },
  );

  it("accepts offline consent proved by a refresh token when omitted from access scopes", async () => {
    const context = await authorized({
      providerId: "amplitude",
      requestedScopes: ["mcp:read", "offline_access"],
      token: {
        access_token: "issued-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
        scope: "mcp:read",
      },
    });
    expect(readNativeConnector(context.id)?.status).toBe("connected");
    expect(context.methods).toContain("initialize");
  });

  it("rejects offline consent without either a refresh token or the returned scope", async () => {
    const context = await mcpConnectorFixture({
      providerId: "amplitude",
      requestedScopes: ["mcp:read", "offline_access"],
      token: {
        access_token: "issued-access",
        token_type: "Bearer",
        scope: "mcp:read",
      },
    });
    await beginNativeMcpAuthorization(context.id);
    await expect(
      finishNativeMcpAuthorization(callback(context.id)),
    ).rejects.toMatchObject({ code: "permission" });
    expect(context.methods).toEqual([]);
    expect(
      requireNativeMcpRecord(context.id).privateState.recovery[0]?.grant
        ?.accessToken,
    ).toBe("issued-access");
  });

  it("seals and revokes a refresh-only initial receipt without fabricating an access token", async () => {
    const context = await mcpConnectorFixture({
      management: true,
      requestedScopes: ["openid"],
      token: {
        access_token: "",
        refresh_token: "partial-refresh-secret",
        token_type: "Bearer",
      },
    });
    await beginNativeMcpAuthorization(context.id);
    await expect(
      finishNativeMcpAuthorization(callback(context.id)),
    ).rejects.toMatchObject({ code: "authorization" });
    const record = requireNativeMcpRecord(context.id);
    expect(record.privateState.grants).toEqual({});
    expect(record.privateState.recovery[0]).toMatchObject({
      credentials: {
        phase: "partial-refresh",
        partial_refresh_token: "partial-refresh-secret",
      },
    });
    expect(record.privateState.recovery[0]?.grant).toBeUndefined();
    expect(JSON.stringify(readDeviceRows())).not.toContain(
      "partial-refresh-secret",
    );
    expect(context.methods).toEqual([]);
    await retryNativeConnectorCleanup(context.id);
    const revoked = context.requests.filter((request) =>
      request.url.endsWith("/ims/revoke"),
    );
    const bodies = await Promise.all(
      revoked.map(async (request) => new URLSearchParams(await request.text())),
    );
    expect(bodies.map((body) => body.get("token"))).toEqual([
      "partial-refresh-secret",
    ]);
    expect(requireNativeMcpRecord(context.id).privateState.recovery).toEqual(
      [],
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  client,
  fixture,
  state,
  target,
  verifier,
} from "./native-mcp-oauth-fixtures.test-helper.js";
import type { NativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";

describe("public browser MCP authorization", () => {
  it("registers an actual public client and retains it before starting S256 consent", async () => {
    const { oauth, requests } = fixture();
    const retain = vi.fn(async () => undefined);
    const registered = await oauth.register(retain);
    expect(retain).toHaveBeenCalledWith(registered);
    const registration = requests.find(
      (request) => request.url === target.metadata.registrationEndpoint,
    );
    expect(await registration?.json()).toMatchObject({
      token_endpoint_auth_method: "none",
      redirect_uris: [target.redirectUri],
      scope: "openid",
    });
    const consent = await oauth.consent(registered, state);
    expect(
      consent.authorizationUrl.origin + consent.authorizationUrl.pathname,
    ).toBe(target.metadata.authorizationEndpoint);
    const params = consent.authorizationUrl.searchParams;
    expect(params.get("resource")).toBe(target.binding.resource);
    expect(params.get("state")).toBe(state);
    expect(params.get("redirect_uri")).toBe(target.redirectUri);
    expect(params.get("code_challenge_method")).toBe("S256");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(consent.codeVerifier),
    );
    expect(params.get("code_challenge")).toBe(
      Buffer.from(digest).toString("base64url"),
    );
  });

  it("uses the pinned cross-origin token endpoint and exact resource without a browser client secret", async () => {
    const { oauth, requests } = fixture();
    const tokens = await oauth.exchange(client, "provider-code", verifier);
    expect(tokens).toMatchObject({
      issuer: target.binding.issuer,
      access_token: "issued-access",
      refresh_token: "rotated-refresh",
    });
    const token = requests.find(
      (request) => request.url === target.metadata.tokenEndpoint,
    );
    const body = new URLSearchParams(await token?.text());
    expect(body.get("resource")).toBe(target.binding.resource);
    expect(body.get("client_id")).toBe(client.client_id);
    expect(body.get("code_verifier")).toBe(verifier);
    expect(body.has("client_secret")).toBe(false);
  });

  it("refreshes and revokes on the selected provider's actual public endpoints", async () => {
    const { oauth, requests } = fixture();
    expect(await oauth.refresh(client, "previous-refresh")).toMatchObject({
      refresh_token: "rotated-refresh",
    });
    await oauth.revoke(client, "issued-access", "access_token");
    const post = requests.filter((request) => request.method === "POST");
    expect(post.map((request) => request.url)).toEqual([
      target.metadata.tokenEndpoint,
      target.metadata.revocationEndpoint,
    ]);
    const body = new URLSearchParams(await post[1]?.text());
    expect(body.get("token")).toBe("issued-access");
    expect(body.get("token_type_hint")).toBe("access_token");
  });

  it("does not fabricate CIMD registration: it retrieves and validates the real metadata document", async () => {
    const selected: NativeMcpOAuthTarget = {
      ...target,
      registration: "cimd",
      clientMetadataUrl:
        "https://self-host.example.org/auth/native-client.json",
      metadata: { ...target.metadata, registration: "cimd" },
    };
    const { oauth, requests } = fixture(selected);
    const registered = await oauth.register(async () => undefined);
    expect(registered.client_id).toBe(selected.clientMetadataUrl);
    expect(
      requests.some((request) => request.url === selected.clientMetadataUrl),
    ).toBe(true);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    await expect(
      fixture(selected, {
        document: {
          client_id: selected.clientMetadataUrl ?? "",
          client_name: "OpenSesame",
          redirect_uris: ["https://other.example.org/callback"],
          token_endpoint_auth_method: "none",
        },
      }).oauth.register(async () => undefined),
    ).rejects.toMatchObject({ code: "public-client" });
  });

  it("uses a real pre-registered public client without attempting DCR", async () => {
    const selected: NativeMcpOAuthTarget = {
      ...target,
      registration: "manual",
      clientId: "registered-by-operator",
    };
    const { oauth, requests } = fixture(selected);
    expect(await oauth.register(async () => undefined)).toMatchObject({
      client_id: "registered-by-operator",
    });
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("refuses confidential-only pinned metadata before any network operation", () => {
    expect(() =>
      fixture({
        ...target,
        metadata: {
          ...target.metadata,
          tokenAuthMethods: ["client_secret_post"],
        },
      }),
    ).toThrow();
    expect(() =>
      fixture({ ...target, metadata: { ...target.metadata, pkce: ["plain"] } }),
    ).toThrow();
  });

  it("refuses live confidential-only admission and changed endpoint metadata before exchanging a code", async () => {
    for (const live of [
      { token_endpoint_auth_methods_supported: ["client_secret_post"] },
      { issuer: "https://attacker.example.org" },
      { token_endpoint: "https://attacker.example.org/token" },
    ]) {
      const { oauth, requests } = fixture(target, { live });
      await expect(oauth.exchange(client, "code", verifier)).rejects.toThrow();
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    }
  });

  it("retains an unexpected confidential DCR result for cleanup before refusing it", async () => {
    const { oauth } = fixture(target, {
      registered: {
        client_id: "unexpected-confidential",
        client_secret: "private-client-secret",
        redirect_uris: [target.redirectUri],
        token_endpoint_auth_method: "client_secret_post",
      },
    });
    const retain = vi.fn(async () => undefined);
    await expect(oauth.register(retain)).rejects.toMatchObject({
      code: "public-client",
    });
    expect(retain).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: "unexpected-confidential",
        client_secret: "private-client-secret",
      }),
    );
  });

  it("returns an already issued token for sealed compensation when activation became stale", async () => {
    let current = true;
    const { oauth } = fixture(target, {
      settle: true,
      assertCurrent: () => {
        if (!current) throw new Error("stale configuration");
      },
      onToken: () => {
        current = false;
      },
    });
    expect(await oauth.exchange(client, "code", verifier)).toMatchObject({
      access_token: "issued-access",
    });
  });

  it("preserves invalid_grant recovery proof while removing provider error descriptions", async () => {
    const { oauth } = fixture(target, { tokenFailure: true });
    const error = await oauth
      .refresh(client, "revoked-refresh")
      .catch((caught: Error) => caught);
    expect(error).toMatchObject({
      code: "authorization",
      oauthError: "invalid_grant",
    });
    expect(String(error)).not.toContain("private response detail");
  });
  it("preserves the actual RFC7592 management receipt before SDK parsing strips it", async () => {
    const { oauth } = fixture(target, {
      registered: {
        client_id: "actual-public-client",
        redirect_uris: [target.redirectUri],
        token_endpoint_auth_method: "none",
        registration_client_uri:
          "https://express-mcp-service.adobe.io/register/actual-public-client",
        registration_access_token: "private-management-token",
      },
    });
    const retained = vi.fn(async () => undefined);
    const registered = await oauth.register(retained);
    expect(registered).toMatchObject({
      registration_client_uri:
        "https://express-mcp-service.adobe.io/register/actual-public-client",
      registration_access_token: "private-management-token",
    });
    expect(retained).toHaveBeenCalledWith(registered);
  });
  it("retains a minted registration even when the SDK rejects the remaining registration metadata", async () => {
    const { oauth } = fixture(target, {
      registered: {
        client_id: "actual-public-client",
        registration_client_uri:
          "https://express-mcp-service.adobe.io/register/actual-public-client",
        registration_access_token: "private-management-token",
      },
    });
    const retained = vi.fn(async () => undefined);
    await expect(oauth.register(retained)).rejects.toThrow();
    expect(retained).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: "actual-public-client",
        registration_access_token: "private-management-token",
      }),
    );
  });
  it.each([
    { access_token: "issued-access", refresh_token: "issued-refresh" },
    {
      access_token: "issued-access",
      refresh_token: "issued-refresh",
      token_type: "Bearer",
      expires_in: "not-an-expiry",
    },
    {
      access_token: "issued-access",
      refresh_token: "issued-refresh",
      token_type: "NotBearer",
    },
  ])(
    "retains a minted pair even when the remaining token reply is malformed %j",
    async (token) => {
      const { oauth } = fixture(target, { token });
      expect(await oauth.exchange(client, "code", verifier)).toMatchObject({
        access_token: "issued-access",
        refresh_token: "issued-refresh",
        protocolValid: false,
      });
    },
  );
});

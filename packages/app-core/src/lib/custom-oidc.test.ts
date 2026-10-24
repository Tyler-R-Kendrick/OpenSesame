import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  type OidcConnectorConfig,
  beginOidcLogin,
  completeOidcLogin,
  discoverOidc,
  oidcConnectorItem,
} from "./custom-oidc.js";

const config: OidcConnectorConfig = {
  name: "Custom OIDC",
  issuer: "https://idp.example",
  authorizationEndpoint: "https://idp.example/authorize",
  tokenEndpoint: "https://idp.example/token",
  jwksUri: "https://idp.example/jwks",
  clientId: "client-1",
  clientSecret: "secret-1",
  callbackUrl: "https://app.example/oidc/callback",
  tokenRelayUrl: "",
  scopes: ["openid", "email"],
  tokenAuth: "client_secret_post",
};

describe("custom OIDC", () => {
  it("discovers only the exact configured issuer", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        issuer: "https://idp.example",
        authorization_endpoint: "https://idp.example/authorize",
        token_endpoint: "https://idp.example/token",
        jwks_uri: "https://idp.example/jwks",
      }),
    ) as unknown as typeof fetch;
    await expect(discoverOidc(config.issuer, fetchImpl)).resolves.toMatchObject(
      {
        issuer: config.issuer,
      },
    );
    await expect(
      discoverOidc("https://other.example", async () =>
        Response.json({
          issuer: "https://idp.example",
          authorization_endpoint: "https://idp.example/authorize",
          token_endpoint: "https://idp.example/token",
          jwks_uri: "https://idp.example/jwks",
        }),
      ),
    ).rejects.toThrow("does not match");
  });

  it("builds a PKCE authorization request with state and nonce", async () => {
    const { url, pending } = await beginOidcLogin(config);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe(pending.state);
    expect(parsed.searchParams.get("nonce")).toBe(pending.nonce);
    expect(parsed.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
    expect(parsed.searchParams.get("scope")).toBe("openid email");
  });

  it("exchanges the code with a client secret and verifies the ID token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test";
    jwk.alg = "RS256";
    const { pending } = await beginOidcLogin(config);
    const idToken = await new SignJWT({
      nonce: pending.nonce,
      sub: "person-1",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(config.issuer)
      .setAudience(config.clientId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const fetchImpl = vi.fn(async (_url, init) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("client_secret")).toBe("secret-1");
      expect(form.get("code_verifier")).toBe(pending.codeVerifier);
      return Response.json({
        access_token: "access-1",
        id_token: idToken,
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_in: 300,
      });
    }) as unknown as typeof fetch;
    const callbackUrl = `${config.callbackUrl}?code=code-1&state=${pending.state}`;
    const tokens = await completeOidcLogin(pending, callbackUrl, {
      fetchImpl,
      jwks: { keys: [jwk] },
    });
    expect(tokens).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
    });
    expect(tokens.expiresAt).toBeTruthy();
  });

  it("stores the configuration and tokens in one vault secret item", () => {
    const item = oidcConnectorItem(config, {
      accessToken: "access-1",
      tokenType: "Bearer",
      refreshToken: "refresh-1",
    });
    expect(item.kind).toBe("secret");
    expect(JSON.parse(item.value)).toMatchObject({
      clientId: "client-1",
      clientSecret: "secret-1",
      tokens: { accessToken: "access-1" },
    });
    expect(item.fields.map((field) => field.name)).toContain("Client ID");
  });

  it("posts the authorization code to a configured relay without the secret", async () => {
    const { pending } = await beginOidcLogin({
      ...config,
      tokenRelayUrl: "https://relay.example/oidc/token",
    });
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://relay.example/oidc/token");
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("client_secret")).toBeNull();
      expect(form.get("code")).toBe("code-1");
      return Response.json({
        access_token: "access-1",
        token_type: "Bearer",
      });
    }) as unknown as typeof fetch;
    await expect(
      completeOidcLogin(
        pending,
        `${config.callbackUrl}?code=code-1&state=${pending.state}`,
        { fetchImpl },
      ),
    ).resolves.toMatchObject({ accessToken: "access-1" });
  });

  it("refuses a state mismatch", async () => {
    const { pending } = await beginOidcLogin(config);
    await expect(
      completeOidcLogin(
        pending,
        `${config.callbackUrl}?code=code-1&state=wrong`,
        { fetchImpl: vi.fn() as unknown as typeof fetch },
      ),
    ).rejects.toThrow("state does not match");
  });
});

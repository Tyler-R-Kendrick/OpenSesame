import { describe, expect, it } from "vitest";
import {
  OAUTH2_PROXY_PINNED_VERSION,
  oauth2ProxyConfig,
  oauth2ProxyDiscoveryGaps,
} from "./oauth2-proxy-recipe.js";

const DISCOVERY = {
  issuer: "https://id.example",
  authorization_endpoint: "https://id.example/auth",
  token_endpoint: "https://id.example/token",
  jwks_uri: "https://id.example/jwks",
  userinfo_endpoint: "https://id.example/me",
  code_challenge_methods_supported: ["S256"],
};

describe("oauth2-proxy recipe", () => {
  it("emits a public PKCE config with the pinned version and no secret", () => {
    const cfg = oauth2ProxyConfig({
      discovery: DISCOVERY,
      clientId: "origin:https://app.example",
      redirectUrl: "https://app.example/oauth2/callback",
    });
    expect(cfg).toContain(OAUTH2_PROXY_PINNED_VERSION);
    expect(cfg).toContain('provider = "oidc"');
    expect(cfg).not.toMatch(/client_secret/i);
    expect(oauth2ProxyDiscoveryGaps(DISCOVERY)).toEqual([]);
  });

  it("refuses incomplete discovery and missing PKCE S256", () => {
    expect(
      oauth2ProxyDiscoveryGaps({
        ...DISCOVERY,
        userinfo_endpoint: "",
      }),
    ).toEqual(["userinfo_endpoint"]);
    expect(() =>
      oauth2ProxyConfig({
        discovery: {
          ...DISCOVERY,
          code_challenge_methods_supported: ["plain"],
        },
        clientId: "app",
        redirectUrl: "https://app.example/cb",
      }),
    ).toThrow(/S256/);
  });
});

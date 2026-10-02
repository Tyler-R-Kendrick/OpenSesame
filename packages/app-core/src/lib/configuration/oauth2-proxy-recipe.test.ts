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

  it("rejects values that would inject config directives", () => {
    expect(() =>
      oauth2ProxyConfig({
        discovery: {
          ...DISCOVERY,
          issuer:
            'https://id.example"\ninsecure_oidc_allow_unverified_email = true',
        },
        clientId: "app",
        redirectUrl: "https://app.example/cb",
      }),
    ).toThrow(/quotes, backslashes, or line breaks/);
    expect(() =>
      oauth2ProxyConfig({
        discovery: DISCOVERY,
        clientId: 'app"\nskip_provider_button = false',
        redirectUrl: "https://app.example/cb",
      }),
    ).toThrow(/quotes, backslashes, or line breaks/);
    expect(() =>
      oauth2ProxyConfig({
        discovery: DISCOVERY,
        clientId: "app",
        redirectUrl: 'https://app.example/cb"\r\nset_cookie = false',
      }),
    ).toThrow(/quotes, backslashes, or line breaks/);
    expect(() =>
      oauth2ProxyConfig({
        discovery: DISCOVERY,
        clientId: "app",
        redirectUrl: "https://app.example/cb",
        emailDomains: ['example.com"\ninsecure = true'],
      }),
    ).toThrow(/quotes, backslashes, or line breaks/);
  });

  it("requires https URLs, allowing loopback http for dev", () => {
    expect(() =>
      oauth2ProxyConfig({
        discovery: { ...DISCOVERY, issuer: "http://id.example" },
        clientId: "app",
        redirectUrl: "https://app.example/cb",
      }),
    ).toThrow(/https/);
    expect(() =>
      oauth2ProxyConfig({
        discovery: DISCOVERY,
        clientId: "app",
        redirectUrl: "http://app.example/cb",
      }),
    ).toThrow(/https/);
    expect(() =>
      oauth2ProxyConfig({
        discovery: DISCOVERY,
        clientId: "app",
        redirectUrl: "not a url",
      }),
    ).toThrow(/absolute URL/);
    const dev = oauth2ProxyConfig({
      discovery: { ...DISCOVERY, issuer: "http://127.0.0.1:8788" },
      clientId: "app",
      redirectUrl: "http://localhost:4180/oauth2/callback",
    });
    expect(dev).toContain('oidc_issuer_url = "http://127.0.0.1:8788"');
  });

  it("rejects clientIds and email domains outside their allowlists", () => {
    expect(() =>
      oauth2ProxyConfig({
        discovery: DISCOVERY,
        clientId: "app name;comment",
        redirectUrl: "https://app.example/cb",
      }),
    ).toThrow(/allowlist/);
    expect(() =>
      oauth2ProxyConfig({
        discovery: DISCOVERY,
        clientId: "app",
        redirectUrl: "https://app.example/cb",
        emailDomains: ["example.com,other.example"],
      }),
    ).toThrow(/not a valid domain/);
    const cfg = oauth2ProxyConfig({
      discovery: DISCOVERY,
      clientId: "app",
      redirectUrl: "https://app.example/cb",
      emailDomains: ["example.com", "sub.example.co"],
    });
    expect(cfg).toContain('email_domains = "example.com,sub.example.co"');
  });
});

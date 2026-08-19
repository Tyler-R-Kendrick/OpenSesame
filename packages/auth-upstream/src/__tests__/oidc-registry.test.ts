import { describe, expect, it } from "vitest";
import {
  UpstreamOidcProviderRegistry,
  mockUpstreamProvider,
} from "../oidc-registry.js";

describe("UpstreamOidcProviderRegistry", () => {
  it("registers and retrieves providers by id", () => {
    const registry = new UpstreamOidcProviderRegistry();
    const provider = mockUpstreamProvider();
    registry.register(provider);

    expect(registry.get("mock")).toEqual(provider);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("re-registering the same id replaces the previous entry", () => {
    const registry = new UpstreamOidcProviderRegistry();
    registry.register(mockUpstreamProvider({ displayName: "First" }));
    registry.register(mockUpstreamProvider({ displayName: "Second" }));

    expect(registry.get("mock")?.displayName).toBe("Second");
  });

  it("lists only enabled providers", () => {
    const registry = new UpstreamOidcProviderRegistry();
    registry.register(mockUpstreamProvider({ id: "on", enabled: true }));
    registry.register(mockUpstreamProvider({ id: "off", enabled: false }));

    const enabled = registry.listEnabled();
    expect(enabled.map((p) => p.id)).toEqual(["on"]);
  });

  it("exposes enabled providers with secrets as Better Auth social config", () => {
    const registry = new UpstreamOidcProviderRegistry();
    registry.register(
      mockUpstreamProvider({
        id: "google",
        clientId: "gid",
        clientSecret: "gsecret",
      }),
    );

    expect(registry.toBetterAuthSocialConfig()).toEqual({
      google: { clientId: "gid", clientSecret: "gsecret", enabled: true },
    });
  });

  it("omits providers without a client secret from the social config", () => {
    const registry = new UpstreamOidcProviderRegistry();
    // Public-client providers (PKCE only) have no secret to hand Better Auth.
    registry.register(
      mockUpstreamProvider({ id: "pkce-only", clientSecret: undefined }),
    );
    registry.register(mockUpstreamProvider({ id: "disabled", enabled: false }));

    expect(registry.toBetterAuthSocialConfig()).toEqual({});
  });
});

describe("mockUpstreamProvider", () => {
  it("defaults to the local mock IdP endpoints", () => {
    const provider = mockUpstreamProvider();
    expect(provider.id).toBe("mock");
    expect(provider.issuer).toBe("http://127.0.0.1:9090");
    expect(provider.discoveryUrl).toBe(
      "http://127.0.0.1:9090/.well-known/openid-configuration",
    );
    expect(provider.enabled).toBe(true);
    expect(provider.scopes).toContain("openid");
  });

  it("applies overrides over the defaults", () => {
    const provider = mockUpstreamProvider({
      id: "entra",
      issuer: "https://login.microsoftonline.com/tenant/v2.0",
      enabled: false,
    });
    expect(provider.id).toBe("entra");
    expect(provider.issuer).toBe(
      "https://login.microsoftonline.com/tenant/v2.0",
    );
    expect(provider.enabled).toBe(false);
    // Untouched fields keep their defaults.
    expect(provider.clientId).toBe("opensesame-upstream");
  });
});

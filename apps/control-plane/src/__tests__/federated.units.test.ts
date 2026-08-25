import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import type { ControlPlaneConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { mintAppleClientSecret } from "../interactions/apple-secret.js";
import {
  beginFederatedAuth,
  clientModeFor,
  completeFederatedAuth,
  federatedUpstreams,
} from "../interactions/federated.js";
import type { OidcProviderDescriptor } from "../interactions/registry.js";

/**
 * Atomic units for the federated leg's guards.
 *
 * The route and chaos suites drive whole journeys; these call the guards
 * directly, because several are reachable only in situations a journey cannot
 * easily produce — a trust decision withdrawn between start and callback, or a
 * client mode whose broker is never actually reached. A guard whose ordering
 * is pinned but whose body never runs is a guard nobody has checked.
 */

function ctxWith(overrides: Partial<ControlPlaneConfig> = {}): AppContext {
  return overlapCast({
    config: {
      publicUrl: "https://identity.example",
      allowDevDefaults: false,
      trustedUpstreamIssuers: ["https://shoo.dev"],
      providers: [],
      ...overrides,
    },
    // The trust fence reads both stores (C2/C6); a deployment always has them,
    // so a context without them would be a shape the guards never meet. These
    // are the real answers for an issuer nobody registered.
    repos: { byoUpstreams: { findByIssuer: async () => null } },
    stores: { organizations: { findByIssuer: async () => undefined } },
  });
}

const PENDING = {
  issuer: "https://shoo.dev",
  state: "st",
  nonce: "no",
  verifier: "ve",
};

describe("trust is resolved again on the way back in", () => {
  /**
   * The pending cookie names its own issuer. Trusting it because "we checked
   * at start" would let a cookie minted before an issuer lost its authority —
   * removed from the allowlist, a BYO record disabled, an organization that
   * dropped its SSO issuer — still complete a sign-in afterwards. The check
   * must run before any network call, so this rejects without one.
   */
  it("refuses a callback whose pending issuer is no longer trusted", async () => {
    await expect(
      completeFederatedAuth(
        ctxWith({ trustedUpstreamIssuers: ["https://shoo.dev"] }),
        { ...PENDING, issuer: "https://evil.example" },
        new URL("https://identity.example/cb?code=c&state=st"),
      ),
    ).rejects.toThrow(/not trusted/);
  });

  it("carries the untrusted_issuer code, not a generic failure", async () => {
    await expect(
      completeFederatedAuth(
        ctxWith(),
        { ...PENDING, issuer: "https://evil.example" },
        new URL("https://identity.example/cb?code=c&state=st"),
      ),
    ).rejects.toMatchObject({ code: "untrusted_issuer" });
  });

  it("refuses to start against an issuer nothing vouches for", async () => {
    await expect(
      beginFederatedAuth(ctxWith(), "uid-1", "https://evil.example"),
    ).rejects.toMatchObject({ code: "untrusted_issuer" });
  });

  it("refuses an empty issuer rather than treating it as unset", async () => {
    await expect(
      beginFederatedAuth(ctxWith(), "uid-1", ""),
    ).rejects.toMatchObject({ code: "untrusted_issuer" });
  });

  it("refuses a look-alike of an allowlisted issuer", async () => {
    // Normalization is trailing-slash only. A hostname that merely contains an
    // allowlisted one, or the same host over http, is a different issuer.
    for (const near of [
      "https://shoo.dev.evil.test",
      "http://shoo.dev",
      "https://evil.test/https://shoo.dev",
    ]) {
      await expect(
        beginFederatedAuth(ctxWith(), "uid-1", near),
      ).rejects.toMatchObject({ code: "untrusted_issuer" });
    }
  });
});

/**
 * Client mode is derived per trust resolution and never from a global (T10).
 * `originProfile` decides whether an `Origin` header is claimed on the token
 * request, and exactly one mode may claim it: the secret-less client whose id
 * encodes our own origin. Everything else is bound by a credential, and a
 * credential plus a claimed browser origin is a mode violation the reference
 * IdP answers with `origin_cors_denied`.
 */
describe("client mode per trust resolution", () => {
  const config = ctxWith().config;

  function oidc(
    overrides: Partial<OidcProviderDescriptor>,
  ): OidcProviderDescriptor {
    return {
      id: "p",
      kind: "oidc",
      label: "P",
      issuer: "https://idp.example",
      scopes: "openid email profile",
      clientAuth: "none",
      ...overrides,
    };
  }

  it("derives the origin-profile client id for a secret-less provider", async () => {
    const mode = await clientModeFor(config, {
      source: "static",
      provider: oidc({ clientAuth: "none" }),
    });
    expect(mode.clientId).toBe("origin:https://identity.example");
    expect(mode.originProfile).toBe(true);
  });

  it("does not claim an origin for a registered public client", async () => {
    // `clientAuth: "none"` WITH a configured client id is an IdP that issues
    // no secret, not our derived origin profile. Sending an Origin header
    // there claims a browser flow that never happened.
    const mode = await clientModeFor(config, {
      source: "static",
      provider: oidc({ clientAuth: "none", clientId: "registered-public" }),
    });
    expect(mode.clientId).toBe("registered-public");
    expect(mode.originProfile).toBe(false);
  });

  it("never claims an origin for a confidential provider", async () => {
    const mode = await clientModeFor(config, {
      source: "static",
      provider: oidc({
        clientAuth: "client_secret_post",
        clientId: "cid",
        clientSecret: "shh",
      }),
    });
    expect(mode.clientId).toBe("cid");
    expect(mode.originProfile).toBe(false);
  });

  it("never claims an origin for a bring-your-own upstream", async () => {
    const mode = await clientModeFor(config, {
      source: "byo",
      record: {
        id: "byo_1",
        issuer: "https://keycloak.example",
        label: "Keycloak",
        clientId: "their-client",
        clientAuth: "none",
        registrationSource: "manual",
        state: "active",
        createdAt: new Date(),
      },
    });
    // The record names a client at THEIR IdP; our origin means nothing there.
    expect(mode.clientId).toBe("their-client");
    expect(mode.originProfile).toBe(false);
  });

  it("uses the origin profile for an organization's own issuer", async () => {
    const mode = await clientModeFor(config, {
      source: "org",
      organizationId: "org_1",
      issuer: "https://tenant.example",
      method: "sso",
    });
    expect(mode.clientId).toBe("origin:https://identity.example");
    expect(mode.originProfile).toBe(true);
  });

  it("carries the provider's own scopes, not a hardcoded set", async () => {
    const mode = await clientModeFor(config, {
      source: "static",
      provider: oidc({ scopes: "openid email name" }),
    });
    expect(mode.scopes).toBe("openid email name");
  });

  it("carries form_post through so the authorize URL can ask for it", async () => {
    const mode = await clientModeFor(config, {
      source: "static",
      provider: oidc({ responseMode: "form_post" }),
    });
    expect(mode.responseMode).toBe("form_post");
  });

  it("refuses to run an oauth2 descriptor through the OIDC leg", async () => {
    // Trusted, but not this leg's: an OAuth2 provider publishes no discovery
    // document and issues no id_token, which is why the generic leg exists.
    await expect(
      clientModeFor(config, {
        source: "static",
        provider: {
          id: "github",
          kind: "oauth2",
          label: "GitHub",
          issuer: "https://github.com",
          authorizationEndpoint: "https://github.com/login/oauth/authorize",
          tokenEndpoint: "https://github.com/login/oauth/access_token",
          userinfoEndpoint: "https://api.github.com/user",
          scopes: "read:user",
          subjectField: "id",
          clientId: "cid",
          clientSecret: "shh",
        },
      }),
    ).rejects.toMatchObject({ code: "discovery_failed" });
  });
});

/**
 * Apple's client secret is a minted ES256 assertion (D3). The signing key is
 * generated at runtime here — no key material is ever committed (T19).
 */
describe("apple client secret", () => {
  async function appleKey(): Promise<string> {
    const { generateKeyPair, exportPKCS8 } = await import("jose");
    const { privateKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    return exportPKCS8(privateKey);
  }

  it("mints the assertion Apple's token endpoint expects, and reuses it", async () => {
    const privateKeyPem = await appleKey();
    const key = { teamId: "TEAM123456", keyId: "KEY1234567", privateKeyPem };
    const first = await mintAppleClientSecret(key, "com.example.service");
    const [header, payload] = first
      .split(".")
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, "base64url").toString()));
    expect(header).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    expect(payload).toMatchObject({
      iss: "TEAM123456",
      sub: "com.example.service",
      aud: "https://appleid.apple.com",
    });
    // Short-lived by choice: minutes, not Apple's six-month ceiling.
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(900);

    const second = await mintAppleClientSecret(key, "com.example.service");
    expect(second).toBe(first);
  });

  it("mints a separate assertion per client id", async () => {
    const privateKeyPem = await appleKey();
    const key = { teamId: "TEAM123456", keyId: "KEY1234567", privateKeyPem };
    const one = await mintAppleClientSecret(key, "com.example.one");
    const two = await mintAppleClientSecret(key, "com.example.two");
    expect(one).not.toBe(two);
  });

  it("fails loudly on a key it cannot parse", async () => {
    // A misconfigured provider must break the sign-in, not quietly send a
    // secret-less request Apple would refuse with an opaque error.
    await expect(
      mintAppleClientSecret(
        { teamId: "T", keyId: "K", privateKeyPem: "-----BEGIN NOPE-----" },
        "com.example.service",
      ),
    ).rejects.toThrow();
  });
});

describe("describing an issuer that is not a URL", () => {
  /**
   * `trustedUpstreamIssuers` is operator-supplied config. A typo must degrade
   * to showing the raw string on the login page, not throw while rendering it
   * — a broken entry should cost one unusable button, not the whole page.
   */
  it("falls back to the raw string instead of throwing", () => {
    const upstreams = federatedUpstreams(
      overlapCast({ trustedUpstreamIssuers: ["not-a-url"] }),
    );
    expect(upstreams).toEqual([
      { id: "not-a-url", issuer: "not-a-url", label: "not-a-url" },
    ]);
  });

  it("keeps describing the valid entries either side of a broken one", () => {
    const upstreams = federatedUpstreams(
      overlapCast({
        trustedUpstreamIssuers: [
          "https://shoo.dev",
          ":::",
          "http://127.0.0.1:9090",
        ],
      }),
    );
    // Allowlist order is preserved, which is also the order the buttons
    // render in — a broken entry must not reshuffle the working ones.
    expect(upstreams.map((u) => u.id)).toEqual(["shoo", ":::", "mock"]);
    expect(upstreams.find((u) => u.id === "shoo")?.label).toBe("Google");
  });
});

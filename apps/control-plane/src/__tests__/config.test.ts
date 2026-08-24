import { afterEach, describe, expect, it } from "vitest";
import {
  type ControlPlaneConfig,
  assertListenHostAllowed,
  assertSecureConfig,
} from "../config.js";

function prodBase(): ControlPlaneConfig {
  return {
    host: "127.0.0.1",
    port: 8788,
    publicUrl: "https://id.example",
    issuer: "https://id.example",
    claimPepper: "unique-claim-pepper-not-dev",
    provisionalCookieName: "os_provisional",
    provisionalTtlMs: 86_400_000,
    logLevel: "info",
    allowPrincipalBearer: false,
    allowDevDefaults: false,
    bootstrapPersonalOrganization: false,
    isProduction: true,
    corsOrigins: ["https://app.example"],
    hostApiUrl: "https://host.example",
    operatorToken: "operator-secret",
    mappingResolveToken: "mapping-resolve-secret",
    trustedUpstreamIssuers: ["https://issuer.example"],
    protocolFeatures: {
      oid4vp: false,
      oid4vci: false,
      fedcm: false,
      digitalCredentialsApi: false,
      openidFederation: false,
      sdJwtVc: false,
      tokenStatusList: false,
      presentationAgentIntents: false,
    },
  };
}

describe("assertSecureConfig", () => {
  it("accepts a production config with explicit CORS origins", () => {
    expect(() => assertSecureConfig(prodBase())).not.toThrow();
  });

  it("rejects wildcard CORS in production", () => {
    expect(() =>
      assertSecureConfig({ ...prodBase(), corsOrigins: ["*"] }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it("rejects empty CORS allowlist in production", () => {
    expect(() =>
      assertSecureConfig({ ...prodBase(), corsOrigins: [] }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it("rejects non-loopback listen host without override", () => {
    expect(() =>
      assertSecureConfig({ ...prodBase(), host: "0.0.0.0" }),
    ).toThrow(/not loopback/);
  });

  it("rejects an empty trusted upstream allowlist in production", () => {
    expect(() =>
      assertSecureConfig({ ...prodBase(), trustedUpstreamIssuers: [] }),
    ).toThrow(/TRUSTED_UPSTREAMS/);
  });

  it("rejects a non-https trusted upstream issuer in production", () => {
    expect(() =>
      assertSecureConfig({
        ...prodBase(),
        trustedUpstreamIssuers: ["https://shoo.dev", "http://127.0.0.1:9090"],
      }),
    ).toThrow(/must use https in production/);
  });

  it("permits an empty or http trusted upstream allowlist outside production", () => {
    const dev: ControlPlaneConfig = {
      ...prodBase(),
      isProduction: false,
      trustedUpstreamIssuers: [],
    };
    expect(() => assertSecureConfig(dev)).not.toThrow();
    expect(() =>
      assertSecureConfig({
        ...dev,
        trustedUpstreamIssuers: ["http://127.0.0.1:9090"],
      }),
    ).not.toThrow();
  });

  it("refuses upstream client credentials for an untrusted issuer", () => {
    // A secret configured for an issuer we do not trust has nobody it may
    // legitimately be sent to; failing at boot beats discovering it at runtime.
    expect(() =>
      assertSecureConfig({
        ...prodBase(),
        trustedUpstreamIssuers: ["https://shoo.dev"],
        upstreamClientCredentials: {
          issuer: "https://elsewhere.example",
          clientId: "cid",
          clientSecret: "shh",
        },
      }),
    ).toThrow(/not listed in OPENSESAME_TRUSTED_UPSTREAMS/);
  });

  it("still rejects an http credentialed issuer in production, via the allowlist scan", () => {
    // There is no separate https check for credentials: listing the issuer is
    // mandatory, and the allowlist itself must be https in production. This
    // pins that the combination cannot slip through either way.
    expect(() =>
      assertSecureConfig({
        ...prodBase(),
        trustedUpstreamIssuers: ["http://idp.internal"],
        upstreamClientCredentials: {
          issuer: "http://idp.internal",
          clientId: "cid",
          clientSecret: "shh",
        },
      }),
    ).toThrow(/must use https in production/);
  });

  it("accepts credentials for a trusted https issuer", () => {
    expect(() =>
      assertSecureConfig({
        ...prodBase(),
        trustedUpstreamIssuers: ["https://shoo.dev"],
        upstreamClientCredentials: {
          issuer: "https://shoo.dev",
          clientId: "cid",
          clientSecret: "shh",
        },
      }),
    ).not.toThrow();
  });
});

describe("loadConfig upstream client credentials", () => {
  it("is absent unless issuer, client id and secret are all present", async () => {
    const { loadConfig } = await import("../config.js");
    const base = {
      OPENSESAME_ALLOW_DEV_DEFAULTS: "true",
      OPENSESAME_UPSTREAM_ISSUER: "http://127.0.0.1:9090",
      OPENSESAME_UPSTREAM_CLIENT_ID: "cid",
    };
    // No secret: this is the origin-profile case, handled by derivation.
    expect(loadConfig({ ...base }).upstreamClientCredentials).toBeUndefined();
    // Secret but no client id.
    expect(
      loadConfig({
        OPENSESAME_ALLOW_DEV_DEFAULTS: "true",
        OPENSESAME_UPSTREAM_ISSUER: "http://127.0.0.1:9090",
        OPENSESAME_UPSTREAM_CLIENT_SECRET: "shh",
      }).upstreamClientCredentials,
    ).toBeUndefined();
    // All three.
    expect(
      loadConfig({
        ...base,
        OPENSESAME_UPSTREAM_CLIENT_SECRET: "shh",
      }).upstreamClientCredentials,
    ).toEqual({
      issuer: "http://127.0.0.1:9090",
      clientId: "cid",
      clientSecret: "shh",
    });
  });
});

describe("assertListenHostAllowed", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, "OPENSESAME_ALLOW_NONLOCAL");
    Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_ALLOW_NONLOCAL");
  });

  it("allows loopback", () => {
    expect(() => assertListenHostAllowed("127.0.0.1")).not.toThrow();
  });

  it("allows 0.0.0.0 when OPENSESAME_ALLOW_NONLOCAL=1", () => {
    process.env.OPENSESAME_ALLOW_NONLOCAL = "1";
    expect(() => assertListenHostAllowed("0.0.0.0")).not.toThrow();
  });
});

describe("loadConfig personal workspace bootstrap", () => {
  it("enables personal org bootstrap for local development without DEV_BOOTSTRAP", async () => {
    const { loadConfig } = await import("../config.js");
    const config = loadConfig({
      OPENSESAME_ENV: "development",
      OPENSESAME_ALLOW_DEV_DEFAULTS: "true",
    });
    expect(config.bootstrapPersonalOrganization).toBe(true);
    expect(config.allowDevDefaults).toBe(true);
  });

  it("keeps personal org bootstrap off in production", async () => {
    const { loadConfig } = await import("../config.js");
    const config = loadConfig({
      OPENSESAME_ENV: "production",
      NODE_ENV: "production",
      OPENSESAME_CLAIM_PEPPER: "unique-claim-pepper-not-dev",
      OPENSESAME_OPERATOR_TOKEN: "operator-secret",
      OPENSESAME_CORS_ORIGINS: "https://app.example",
    });
    expect(config.bootstrapPersonalOrganization).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  assertListenHostAllowed,
  assertSecureConfig,
  type ControlPlaneConfig,
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
    isProduction: true,
    corsOrigins: ["https://app.example"],
    hostApiUrl: "https://host.example",
    operatorToken: "operator-secret",
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
});

describe("assertListenHostAllowed", () => {
  afterEach(() => {
    delete process.env.OPENSESAME_ALLOW_NONLOCAL;
    delete process.env.OPENSESAME_DAEMON_ALLOW_NONLOCAL;
  });

  it("allows loopback", () => {
    expect(() => assertListenHostAllowed("127.0.0.1")).not.toThrow();
  });

  it("allows 0.0.0.0 when OPENSESAME_ALLOW_NONLOCAL=1", () => {
    process.env.OPENSESAME_ALLOW_NONLOCAL = "1";
    expect(() => assertListenHostAllowed("0.0.0.0")).not.toThrow();
  });
});

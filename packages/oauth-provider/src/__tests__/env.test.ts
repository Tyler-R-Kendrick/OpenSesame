import { describe, expect, it } from "vitest";
import { readOAuthProviderEnv } from "../env.js";

describe("readOAuthProviderEnv", () => {
  it("defaults every flag off with the loopback issuer", () => {
    const env = readOAuthProviderEnv({});
    expect(env).toEqual({
      originClientsEnabled: false,
      dcrEnabled: false,
      cimdEnabled: false,
      issuer: "http://127.0.0.1:3000",
      allowedResources: [],
      isProduction: false,
    });
  });

  it("accepts common truthy spellings for feature flags", () => {
    for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
      const env = readOAuthProviderEnv({
        OPENSESAME_ORIGIN_CLIENTS_ENABLED: value,
        OPENSESAME_DCR_ENABLED: value,
        OPENSESAME_CIMD_ENABLED: value,
      });
      expect(env.originClientsEnabled, value).toBe(true);
      expect(env.dcrEnabled, value).toBe(true);
      expect(env.cimdEnabled, value).toBe(true);
    }
  });

  it("treats anything else as disabled", () => {
    for (const value of ["0", "false", "no", "off", "", "  ", "enabled"]) {
      const env = readOAuthProviderEnv({ OPENSESAME_DCR_ENABLED: value });
      expect(env.dcrEnabled, JSON.stringify(value)).toBe(false);
    }
  });

  it("honours an explicit issuer", () => {
    const env = readOAuthProviderEnv({
      OPENSESAME_ISSUER: "https://id.example.test",
    });
    expect(env.issuer).toBe("https://id.example.test");
  });

  it("parses the resource allowlist, trimming and dropping empties", () => {
    const env = readOAuthProviderEnv({
      OPENSESAME_ALLOWED_RESOURCES:
        " https://api.example.test ,, https://files.example.test ,",
    });
    expect(env.allowedResources).toEqual([
      "https://api.example.test",
      "https://files.example.test",
    ]);
  });

  it("detects production via NODE_ENV or OPENSESAME_ENV", () => {
    expect(readOAuthProviderEnv({ NODE_ENV: "production" }).isProduction).toBe(
      true,
    );
    expect(
      readOAuthProviderEnv({ OPENSESAME_ENV: "production" }).isProduction,
    ).toBe(true);
    expect(readOAuthProviderEnv({ NODE_ENV: "staging" }).isProduction).toBe(
      false,
    );
  });
});

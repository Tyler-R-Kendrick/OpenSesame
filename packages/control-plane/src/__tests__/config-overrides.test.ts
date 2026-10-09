import { MemoryRepositories } from "@opensesame/database";
import { describe, expect, it } from "vitest";
import { resolveControlPlaneConfig } from "../create-app-options.js";

const localProduction = {
  OPENSESAME_ENV: "production",
  NODE_ENV: "production",
  OPENSESAME_PUBLIC_URL: "https://localhost:8788",
  OPENSESAME_HOST_API: "https://localhost:8787",
  OPENSESAME_CLAIM_PEPPER: "local-test-pepper-at-least-32-characters",
  OPENSESAME_OPERATOR_TOKEN: "local-test-operator",
  OPENSESAME_MAPPING_RESOLVE_TOKEN: "local-test-mapping",
  DATABASE_URL: "postgres://test@127.0.0.1/unused-config-only",
};

describe("production safeguards survive programmatic config overrides", () => {
  it("cannot downgrade declared loopback production", () => {
    const config = resolveControlPlaneConfig(
      { config: { isProduction: false } },
      localProduction,
    );
    expect(config.isProduction).toBe(true);
  });
  it.each([
    ["DATABASE_URL", /DATABASE_URL/],
    ["OPENSESAME_OPERATOR_TOKEN", /OPENSESAME_OPERATOR_TOKEN/],
    ["OPENSESAME_MAPPING_RESOLVE_TOKEN", /OPENSESAME_MAPPING_RESOLVE_TOKEN/],
  ])("still requires %s when a caller requests a downgrade", (name, error) => {
    expect(() =>
      resolveControlPlaneConfig(
        { config: { isProduction: false } },
        { ...localProduction, [String(name)]: undefined },
      ),
    ).toThrow(error);
  });
  it("does not let the downgraded flag admit injected memory stores", () => {
    expect(() =>
      resolveControlPlaneConfig(
        { config: { isProduction: false }, repos: new MemoryRepositories() },
        localProduction,
      ),
    ).toThrow(
      "Production security stores must be constructed from DATABASE_URL",
    );
  });
  it("enforces final networked overrides even for explicitly local test mode", () => {
    const config = resolveControlPlaneConfig(
      {
        config: {
          isProduction: false,
          publicUrl: "https://identity.example",
          issuer: "https://identity.example",
        },
      },
      { ...localProduction, OPENSESAME_ENV: "test", NODE_ENV: "test" },
    );
    expect(config.isProduction).toBe(true);
  });
  it("preserves safe local test overrides and explicit stronger safeguards", () => {
    const env = {
      ...localProduction,
      OPENSESAME_ENV: "test",
      NODE_ENV: "test",
    };
    expect(
      resolveControlPlaneConfig(
        { config: { isProduction: false, port: 9876 } },
        env,
      ),
    ).toMatchObject({ isProduction: false, port: 9876 });
    expect(
      resolveControlPlaneConfig({ config: { isProduction: true } }, env)
        .isProduction,
    ).toBe(true);
  });
});

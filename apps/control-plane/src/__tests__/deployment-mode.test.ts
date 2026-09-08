import { readFileSync } from "node:fs";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { assertSecureConfig, loadConfig } from "../config.js";
import {
  deploymentExposure,
  resolveDeploymentMode,
} from "../deployment-mode.js";

describe("deployment security boundary", () => {
  const cases = overlapCast<
    Array<{
      name: string;
      opensesame_env: string | null;
      node_env: string | null;
      allow_dev_defaults: string | null;
      exposure: "local_only" | "networked";
      expected: string | null;
      production_safeguards: boolean;
    }>
  >(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../contracts/deployment-mode-cases.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  it.each(cases)("matches the Rust deployment truth table: $name", (entry) => {
    const env: NodeJS.ProcessEnv = {};
    if (entry.opensesame_env !== null)
      env.OPENSESAME_ENV = entry.opensesame_env;
    if (entry.node_env !== null) env.NODE_ENV = entry.node_env;
    if (entry.allow_dev_defaults !== null)
      env.OPENSESAME_ALLOW_DEV_DEFAULTS = entry.allow_dev_defaults;
    if (entry.expected === null)
      expect(() => resolveDeploymentMode(env, entry.exposure)).toThrow();
    else
      expect(resolveDeploymentMode(env, entry.exposure)).toMatchObject({
        mode: entry.expected,
        productionSafeguards: entry.production_safeguards,
      });
  });
  it.each(["", " ", "prod", "Production", "stage"])(
    "refuses ambiguous mode %j",
    (value) => {
      expect(() =>
        resolveDeploymentMode({ OPENSESAME_ENV: value }, "local_only"),
      ).toThrow();
      expect(() =>
        resolveDeploymentMode({ NODE_ENV: value }, "local_only"),
      ).toThrow();
    },
  );
  it("does not derive development authority from test-runner detection", () => {
    expect(() =>
      resolveDeploymentMode({ VITEST: "true" }, "local_only"),
    ).toThrow();
    expect(() =>
      resolveDeploymentMode(
        { OPENSESAME_ENV: "development", NODE_ENV: "production" },
        "local_only",
      ),
    ).toThrow(/conflicts/);
    expect(
      resolveDeploymentMode(
        { OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
        "local_only",
      ).mode,
    ).toBe("development");
    expect(() =>
      resolveDeploymentMode(
        { OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
        "networked",
      ),
    ).toThrow();
  });
  it("requires production safeguards for networked development", () => {
    expect(
      resolveDeploymentMode({ OPENSESAME_ENV: "development" }, "networked")
        .productionSafeguards,
    ).toBe(true);
    expect(deploymentExposure("127.0.0.1", ["https://identity.example"])).toBe(
      "networked",
    );
    expect(deploymentExposure("0.0.0.0", ["http://127.0.0.1:8788"])).toBe(
      "networked",
    );
  });
  it("has no implicit server trust or shared development credential", () => {
    const env = { OPENSESAME_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" };
    const first = loadConfig(env);
    const second = loadConfig(env);
    expect(first.corsOrigins).toEqual([]);
    expect(first.trustedUpstreamIssuers).toEqual([]);
    expect(first.operatorToken).toBe("");
    expect(first.mappingResolveToken).toBe("");
    expect(first.claimPepper).not.toBe(second.claimPepper);
  });
  it("rejects production without a durable database before composition", () => {
    const config = loadConfig({
      OPENSESAME_ENV: "production",
      OPENSESAME_PUBLIC_URL: "https://identity.example",
      OPENSESAME_ISSUER: "https://identity.example",
      OPENSESAME_HOST_API: "https://host.example",
      OPENSESAME_CLAIM_PEPPER: "x".repeat(32),
      OPENSESAME_OPERATOR_TOKEN: "operator-test",
      OPENSESAME_MAPPING_RESOLVE_TOKEN: "mapping-test",
    });
    expect(() => assertSecureConfig(config, {})).toThrow(/DATABASE_URL/);
  });
});

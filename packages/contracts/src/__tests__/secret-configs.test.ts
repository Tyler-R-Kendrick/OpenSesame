import { describe, expect, it } from "vitest";
import {
  BranchConfigBodySchema,
  CompareConfigsResponseSchema,
  ConfigKeyMetaSchema,
  ConfigKeysResponseSchema,
  ConfigSecretVersionSchema,
  CreateSecretConfigBodySchema,
  ListConfigSecretVersionsResponseSchema,
  ListSecretConfigsResponseSchema,
  PutConfigSecretsBodySchema,
  RollbackConfigSecretBodySchema,
  RollbackConfigSecretResponseSchema,
  SecretConfigEnvironmentSchema,
  SecretConfigViewSchema,
} from "../index.js";

const config = {
  id: "config:01J",
  organization_id: "organization:1",
  project_id: "project:1",
  slug: "production",
  display_name: "Production",
  environment: "production",
  created_at: "2026-08-20T12:00:00.000Z",
  updated_at: "2026-08-20T12:00:00.000Z",
};

const keyMeta = {
  key_name: "DATABASE_URL",
  version: 3,
  updated_at: "2026-08-20T12:05:00.000Z",
};

const version = {
  version: 2,
  deleted: false,
  actor_id: "principal:1",
  created_at: "2026-08-20T12:01:00.000Z",
};

describe("secret-configs contract", () => {
  it("parses config, key-meta and version shapes", () => {
    expect(SecretConfigViewSchema.parse(config).slug).toBe("production");
    expect(
      SecretConfigViewSchema.parse({
        ...config,
        parent_config_id: "config:parent",
      }).parent_config_id,
    ).toBe("config:parent");
    expect(SecretConfigEnvironmentSchema.options).toEqual([
      "development",
      "staging",
      "production",
      "custom",
    ]);
    expect(
      ListSecretConfigsResponseSchema.parse({ configs: [config] }).configs,
    ).toHaveLength(1);
    expect(ConfigKeyMetaSchema.parse(keyMeta).version).toBe(3);
    expect(
      ConfigKeysResponseSchema.parse({ keys: [keyMeta] }).keys,
    ).toHaveLength(1);
    expect(ConfigSecretVersionSchema.parse(version).deleted).toBe(false);
    expect(
      ConfigSecretVersionSchema.parse({ ...version, actor_id: null }).actor_id,
    ).toBeNull();
    expect(
      ListConfigSecretVersionsResponseSchema.parse({ versions: [version] })
        .versions,
    ).toHaveLength(1);
    expect(
      RollbackConfigSecretResponseSchema.parse({
        key_name: "DATABASE_URL",
        version: 4,
      }).version,
    ).toBe(4);
    expect(
      CompareConfigsResponseSchema.parse({
        only_in_a: ["ONLY_A"],
        only_in_b: [],
        in_both: [{ key_name: "SHARED", a_version: 1, b_version: 2 }],
      }).in_both[0]?.b_version,
    ).toBe(2);
  });

  it("parses request bodies and rejects unknown fields (deny_unknown_fields)", () => {
    expect(
      CreateSecretConfigBodySchema.parse({
        slug: "development",
        environment: "development",
      }).slug,
    ).toBe("development");
    expect(() =>
      CreateSecretConfigBodySchema.parse({
        slug: "development",
        environment: "development",
        unknown_field: true,
      }),
    ).toThrow();
    expect(
      PutConfigSecretsBodySchema.parse({
        secrets: { API_KEY: "plaintext-here" },
      }).secrets.API_KEY,
    ).toBe("plaintext-here");
    expect(() =>
      PutConfigSecretsBodySchema.parse({
        secrets: { API_KEY: "v" },
        value: "smuggled",
      }),
    ).toThrow();
    expect(
      RollbackConfigSecretBodySchema.parse({ to_version: 1 }).to_version,
    ).toBe(1);
    expect(() =>
      RollbackConfigSecretBodySchema.parse({ to_version: 1, value: "leak" }),
    ).toThrow();
    expect(() =>
      RollbackConfigSecretBodySchema.parse({ to_version: 0 }),
    ).toThrow();
    expect(BranchConfigBodySchema.parse({ slug: "dev-tyler" }).slug).toBe(
      "dev-tyler",
    );
    expect(() =>
      BranchConfigBodySchema.parse({ slug: "dev-tyler", environment: "x" }),
    ).toThrow();
  });

  it("rejects invalid environments", () => {
    expect(() =>
      SecretConfigViewSchema.parse({ ...config, environment: "prod" }),
    ).toThrow();
    expect(() =>
      CreateSecretConfigBodySchema.parse({ slug: "s", environment: "qa" }),
    ).toThrow();
  });

  it("rejects credential material on every response schema", () => {
    for (const leak of [
      { access_token: "at_live" },
      { refresh_token: "rt_live" },
      { client_secret: "cs_live" },
      { value: "secret-value" },
      { plaintext: "secret-value" },
      { password: "pw" },
    ]) {
      expect(() =>
        SecretConfigViewSchema.parse({ ...config, ...leak }),
      ).toThrow();
      expect(() =>
        ListSecretConfigsResponseSchema.parse({
          configs: [{ ...config, ...leak }],
        }),
      ).toThrow();
      expect(() =>
        ConfigKeyMetaSchema.parse({ ...keyMeta, ...leak }),
      ).toThrow();
      expect(() =>
        ConfigKeysResponseSchema.parse({ keys: [{ ...keyMeta, ...leak }] }),
      ).toThrow();
      expect(() =>
        ConfigSecretVersionSchema.parse({ ...version, ...leak }),
      ).toThrow();
      expect(() =>
        ListConfigSecretVersionsResponseSchema.parse({
          versions: [{ ...version, ...leak }],
        }),
      ).toThrow();
      expect(() =>
        RollbackConfigSecretResponseSchema.parse({
          key_name: "K",
          version: 1,
          ...leak,
        }),
      ).toThrow();
      expect(() =>
        CompareConfigsResponseSchema.parse({
          only_in_a: [],
          only_in_b: [],
          in_both: [
            { key_name: "SHARED", a_version: 1, b_version: 1, ...leak },
          ],
        }),
      ).toThrow();
    }
  });
});

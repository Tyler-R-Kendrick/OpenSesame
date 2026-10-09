import { Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { isBundledProviderId } from "../bundled-provider-ids.js";
import { catalogProvider } from "../connector-catalog.js";
import { S3_PROVIDER_ID, s3ConfigFrom, s3Missing } from "./s3-config.js";

const whole = {
  fields: {
    endpoint: " https://s3.eu-west-1.amazonaws.com ",
    region: "eu-west-1",
    bucket: "vault-bucket",
    prefix: "vaults/me",
    access_key_id: "AKIATEST",
  },
  secrets: { secret_access_key: "s3cr3t", session_token: "" },
};

describe("the saved S3 connection", () => {
  it("becomes a store configuration, trimmed, with its secrets held redacted", () => {
    const config = s3ConfigFrom(whole);
    expect(config?.endpoint).toBe("https://s3.eu-west-1.amazonaws.com");
    expect(config?.prefix).toBe("vaults/me");
    expect(
      Redacted.value(config?.credentials.secretAccessKey ?? Redacted.make("")),
    ).toBe("s3cr3t");
    expect(config?.credentials.sessionToken).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("s3cr3t");
  });

  it("names what is missing and builds nothing until it is whole", () => {
    expect(s3Missing({ fields: {}, secrets: {} })).toEqual([
      "endpoint",
      "region",
      "bucket",
      "access_key_id",
      "secret_access_key",
    ]);
    expect(s3ConfigFrom({ fields: whole.fields, secrets: {} })).toBeNull();
    expect(s3Missing(whole)).toEqual([]);
  });

  it("reads exactly the fields the catalog's s3 connector declares, secrets kept apart", () => {
    const fields = catalogProvider(S3_PROVIDER_ID)?.configurationFields ?? [];
    expect(catalogProvider(S3_PROVIDER_ID)?.authKind).toBe("configuration");
    // Pages draws only the catalog rows it bundles: without this the tile is absent.
    expect(isBundledProviderId(S3_PROVIDER_ID)).toBe(true);
    expect(fields.filter((field) => field.secret).map((f) => f.name)).toEqual([
      "secret_access_key",
      "session_token",
    ]);
    const named = new Set(fields.map((field) => field.name));
    for (const name of s3Missing({ fields: {}, secrets: {} })) {
      expect(named.has(name)).toBe(true);
    }
    for (const name of ["prefix", "session_token"]) {
      expect(named.has(name)).toBe(true);
    }
  });
});

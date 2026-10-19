import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECRET_BACKEND_PRESETS } from "./presets.generated.js";
import { secretBackendDraft } from "./presets.js";
import {
  publicSecretBackendDraft,
  validateSecretBackendDraft,
} from "./schema.js";

describe("shared browser secret backend configuration", () => {
  it("derives partner presets from the shared protocol source", () => {
    const spec = JSON.parse(
      readFileSync(
        new URL(
          "../../../../../spec/connectors/secret-backend-presets.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(SECRET_BACKEND_PRESETS).toEqual(spec.providers);
    for (const preset of SECRET_BACKEND_PRESETS)
      expect(preset.modes).toContain(preset.defaultMode);
  });

  it("keeps private credentials and transient files outside the public configuration", () => {
    const draft = {
      ...secretBackendDraft("infisical"),
      token: "private-fixture",
      clientSecret: "private-client-fixture",
      filePassword: "transient-fixture",
    };
    const publicDraft = publicSecretBackendDraft(draft);
    expect(publicDraft.token).toBe("");
    expect(publicDraft.clientSecret).toBe("");
    expect(JSON.stringify(publicDraft)).not.toContain("fixture");
    expect(publicDraft).not.toHaveProperty("filePassword");
  });

  it("rejects protocol and format substitution across partner pages", () => {
    expect(() =>
      validateSecretBackendDraft({
        ...secretBackendDraft("proton-pass"),
        mode: "passwordstate",
      }),
    ).toThrow();
    expect(() =>
      validateSecretBackendDraft({
        ...secretBackendDraft("proton-pass"),
        mode: "file-import",
        fileFormat: "generic-csv",
      }),
    ).toThrow();
    expect(
      validateSecretBackendDraft({
        ...secretBackendDraft("proton-pass"),
        mode: "file-import",
      }).fileFormat,
    ).toBe("protonpass-json");
  });

  it("defaults Proton to the real native protocol and admits the same protocol through BYO", () => {
    expect(secretBackendDraft("proton-pass").mode).toBe("proton-pass");
    const token = `pst_${"P".repeat(64)}::${Buffer.from(new Uint8Array(32).fill(17)).toString("base64url")}`;
    const config = {
      ...secretBackendDraft("proton-pass"),
      baseUrl: "https://pass-api.proton.me/api",
      token,
      vaultId: "scoped-share",
      appVersion: "web-opensesame@2.0.0",
    };
    expect(validateSecretBackendDraft(config).appVersion).toBe(
      config.appVersion,
    );
    expect(
      validateSecretBackendDraft({
        ...config,
        providerId: "byo-secret-backend",
      }).mode,
    ).toBe("proton-pass");
    const projected = publicSecretBackendDraft(config);
    expect(projected.token).toBe("");
    expect(projected.appVersion).toBe(config.appVersion);
    for (const invalid of [
      { ...config, appVersion: "" },
      { ...config, vaultId: ".." },
      { ...config, token: "not-a-scoped-token" },
      { ...config, token: "", clientId: config.appVersion },
    ])
      expect(() => validateSecretBackendDraft(invalid)).toThrow();
    expect(
      validateSecretBackendDraft({ ...config, token: "" }, false).token,
    ).toBe("");
  });

  it("requires connection-specific targets and credentials", () => {
    const draft = {
      ...secretBackendDraft("1password"),
      baseUrl: "https://secrets.example.test",
      vaultId: "vault",
    };
    expect(() => validateSecretBackendDraft(draft)).toThrow();
    expect(
      validateSecretBackendDraft({ ...draft, token: "scoped-fixture" }).vaultId,
    ).toBe("vault");
    expect(() =>
      validateSecretBackendDraft({
        ...draft,
        token: "scoped-fixture",
        name: "scoped-fixture",
      }),
    ).toThrow();
  });
});

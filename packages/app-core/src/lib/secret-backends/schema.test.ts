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
        fileFormat: "generic-csv",
      }),
    ).toThrow();
    expect(
      validateSecretBackendDraft(secretBackendDraft("proton-pass")).fileFormat,
    ).toBe("protonpass-json");
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

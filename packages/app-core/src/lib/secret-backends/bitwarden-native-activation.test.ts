import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createSecretBackend } from "./factory.js";
import { SECRET_BACKEND_PRESETS } from "./presets.generated.js";
import { secretBackendDraft, secretBackendModeLabel } from "./presets.js";
import {
  publicSecretBackendDraft,
  validateSecretBackendDraft,
} from "./schema.js";
import { bindSecretBackendTransport } from "./transport.js";

const closures: (() => void)[] = [];
afterEach(() => {
  for (const close of closures.splice(0)) close();
});
function configured(providerId = "bitwarden") {
  return {
    ...secretBackendDraft(providerId),
    mode: "bitwarden-api" as const,
    baseUrl: "https://owned.example/api",
    identityUrl: "https://owned.example/identity",
    accountEmail: "owned@example.test",
    clientId: "user.00000000-0000-4000-8000-000000000001",
    clientSecret: "owned-personal-api-secret",
    deviceIdentifier: "00000000-0000-4000-8000-000000000002",
  };
}
it.each(["bitwarden", "vaultwarden", "byo-secret-backend"])(
  "validates the actual personal-account configuration for %s without storing an unlock password",
  (providerId) => {
    const input = {
      ...configured(providerId),
      masterPassword: "never-persist",
    };
    expect(validateSecretBackendDraft(input)).toMatchObject({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      accountEmail: input.accountEmail,
    });
    expect(publicSecretBackendDraft(input)).not.toHaveProperty(
      "masterPassword",
    );
    expect(publicSecretBackendDraft(input).clientSecret).toBe("");
    expect(
      validateSecretBackendDraft({ ...input, clientSecret: "" }, false)
        .clientSecret,
    ).toBe("");
    expect(() =>
      validateSecretBackendDraft({ ...input, clientSecret: "" }),
    ).toThrow();
  },
);
it("refuses absent/mismatched personal identity settings, unsupported organization targets and unsafe endpoints before network access", () => {
  for (const edit of [
    { accountEmail: "" },
    { accountEmail: "not-email" },
    { deviceIdentifier: "" },
    { deviceIdentifier: "not-uuid" },
    { clientId: "organization.00000000-0000-4000-8000-000000000001" },
    { clientId: "user.not-uuid" },
    { clientSecret: "" },
    { clientSecret: "x".repeat(4097) },
    { identityUrl: "" },
    { identityUrl: "http://owned.example/identity" },
    { identityUrl: "https://owned.example/identity?token=bad" },
    { organizationId: "organization" },
    { vaultId: "not-a-personal-folder-id" },
  ])
    expect(() =>
      validateSecretBackendDraft({ ...configured(), ...edit }),
    ).toThrow();
  expect(
    validateSecretBackendDraft({
      ...configured(),
      vaultId: "00000000-0000-4000-8000-000000000003",
    }).vaultId,
  ).toBeTruthy();
});
it("uses generated native partner presets and hosted defaults with configurable regional/self-hosted endpoints", () => {
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
  expect(secretBackendDraft("bitwarden")).toMatchObject({
    mode: "bitwarden-api",
    baseUrl: "https://api.bitwarden.com",
    identityUrl: "https://identity.bitwarden.com",
  });
  expect(secretBackendDraft("vaultwarden")).toMatchObject({
    mode: "bitwarden-api",
    baseUrl: "",
    identityUrl: "",
  });
  expect(secretBackendModeLabel("bitwarden-api")).toBe(
    "Bitwarden-compatible personal vault",
  );
  for (const id of ["bitwarden", "vaultwarden"]) {
    const setup = SECRET_BACKEND_PRESETS.find(
      (preset) => preset.providerId === id,
    )?.setup;
    expect(setup).toContain("personal");
    expect(setup).not.toContain("bw serve");
    expect(setup).not.toContain("Vault Management API service");
  }
});
it("routes the existing common method to the native worker adapter without allocating a worker or making a provider call merely to configure it", async () => {
  const owner = new AbortController();
  let requests = 0;
  closures.push(
    bindSecretBackendTransport({
      signal: owner.signal,
      assertCurrent: () => owner.signal.throwIfAborted(),
      fetch: async () => {
        requests++;
        throw new Error("No provider operation was authorized.");
      },
    }),
  );
  const backend = await createSecretBackend("bitwarden-api");
  expect(backend.id).toBe("bitwarden-native");
  expect(backend.capabilities).toMatchObject({
    list: true,
    get: true,
    create: true,
    update: true,
    delete: true,
    vaultBackup: { kind: "note", field: "notes" },
  });
  expect(requests).toBe(0);
  owner.abort();
});

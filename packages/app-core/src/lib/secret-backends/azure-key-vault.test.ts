import { afterEach, describe, expect, it } from "vitest";
import {
  AZURE_SECRET_BYTES,
  azureNextPage,
  azureSecretReference,
  azureVaultBase,
} from "./azure-key-vault-codec.js";
import {
  AZURE_FIXTURE_TOKEN,
  azureHttpFixture,
} from "./azure-key-vault-http.test-support.js";
import { createAzureKeyVaultSecretBackend } from "./azure-key-vault.js";
import { SecretBackendHttpError } from "./http.js";
import type {
  SecretBackendConfiguration,
  SecretBackendItemInput,
} from "./types.js";

type Fixture = Awaited<ReturnType<typeof azureHttpFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    expect(fixture.errors).toEqual([]);
  }
});
function config(origin: string): SecretBackendConfiguration {
  return {
    providerId: "azure-sm",
    name: "Owned Azure vault",
    mode: "local",
    baseUrl: origin,
    token: AZURE_FIXTURE_TOKEN,
    identityUrl: "",
    vaultId: "",
    projectId: "",
    organizationId: "",
    environment: "",
    secretPath: "",
    clientId: "",
    clientSecret: "",
    passwordListId: "",
    fileFormat: "",
  };
}
function input(
  name = "owned-secret",
  secret = "native-value",
): SecretBackendItemInput {
  return { name, kind: "secret", secret, notes: "" };
}
async function setup() {
  const fixture = await azureHttpFixture();
  fixtures.push(fixture);
  const backend = createAzureKeyVaultSecretBackend(fixture.transport);
  const session = await backend.authenticate(config(fixture.origin));
  return { fixture, backend, session };
}
describe("native Azure Key Vault Secrets against an independent owned HTTP provider", () => {
  it("authenticates and performs native CRUD while preserving immutable history and metadata", async () => {
    const { fixture, backend, session } = await setup();
    const created = await backend.createItem?.(input(), session);
    expect(created).toEqual({
      id: `${fixture.origin}/secrets/owned-secret`,
      name: "owned-secret",
      kind: "secret",
      notes: "",
      secret: "native-value",
    });
    expect(await backend.listItems(session)).toEqual([
      { id: created?.id, name: "owned-secret", kind: "secret" },
    ]);
    expect(await backend.getNotes("OWNED-SECRET", session)).toBe(
      "native-value",
    );
    const first = fixture.versions.get("owned-secret")?.[0];
    expect(first).toBeDefined();
    if (!first || !created) throw new Error("Owned first version missing");
    first.tags = { owner: "external", unicode: "安全" };
    first.contentType = "text/plain";
    first.attributes.nbf = 1700000000;
    first.attributes.exp = 1900000000;
    const updated = await backend.updateItem?.(
      created.id,
      input("owned-secret", "changed-安全"),
      session,
    );
    expect(updated?.id).toBe(created.id);
    expect(updated?.secret).toBe("changed-安全");
    expect(await backend.getItem(first.id, session)).toMatchObject({
      id: created.id,
      secret: "native-value",
    });
    expect((await backend.getItem(created.id, session)).secret).toBe(
      "changed-安全",
    );
    const versions = fixture.versions.get("owned-secret");
    expect(versions).toHaveLength(2);
    expect(versions?.[1]).toMatchObject({
      tags: first.tags,
      contentType: first.contentType,
      attributes: { nbf: 1700000000, exp: 1900000000, enabled: true },
    });
    const put = fixture.requests.filter((row) => row.method === "PUT").at(-1);
    expect(put?.body).toEqual({
      value: "changed-安全",
      contentType: "text/plain",
      tags: first.tags,
      attributes: { enabled: true, nbf: 1700000000, exp: 1900000000 },
    });
    await backend.deleteItem?.(created.id, session);
    expect(fixture.versions.has("owned-secret")).toBe(false);
    expect(fixture.deleted.get("owned-secret")).toHaveLength(2);
    expect(
      fixture.requests.some(
        (row) =>
          row.path.includes("/purge") || row.path.includes("/deletedsecrets"),
      ),
    ).toBe(false);
    await expect(backend.getItem(created.id, session)).rejects.toMatchObject({
      code: "not-found",
      status: 404,
    });
  });
  it("paginates logical metadata without requesting values or losing the second page", async () => {
    const { fixture, backend, session } = await setup();
    fixture.seed("alpha", "one");
    fixture.seed("beta", "two");
    const start = fixture.requests.length;
    expect((await backend.listItems(session)).map((item) => item.name)).toEqual(
      ["alpha", "beta"],
    );
    expect(fixture.requests.slice(start)).toHaveLength(2);
    expect(
      fixture.requests
        .slice(start)
        .every((row) => row.path.startsWith("/secrets?")),
    ).toBe(true);
  });
  it("refuses duplicate create, rename, historical mutation and irreversible deletion without PUT/DELETE", async () => {
    const { fixture, backend, session } = await setup();
    const existing = fixture.seed("held", "value");
    await expect(
      backend.createItem?.(input("held"), session),
    ).rejects.toMatchObject({ code: "ambiguous" });
    await expect(
      backend.updateItem?.(existing.id, input("held"), session),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      backend.deleteItem?.(existing.id, session),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      backend.updateItem?.("held", input("renamed"), session),
    ).rejects.toMatchObject({ code: "unsupported" });
    existing.attributes.recoveryLevel = "Purgeable";
    await expect(backend.deleteItem?.("held", session)).rejects.toMatchObject({
      code: "unsupported",
    });
    existing.attributes.recoveryLevel = undefined;
    await expect(backend.deleteItem?.("held", session)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(fixture.requests.some((row) => row.method !== "GET")).toBe(false);
  });
  it("refuses certificate-managed writes and native-incompatible fields before mutation", async () => {
    const { fixture, backend, session } = await setup();
    const existing = fixture.seed("managed", "certificate-owner");
    existing.managed = true;
    await expect(
      backend.updateItem?.("managed", input("managed"), session),
    ).rejects.toMatchObject({ code: "unsupported" });
    for (const extra of [
      { kind: "note" as const },
      { notes: "lose-notes" },
      { username: "lose-user" },
      { url: "https://example.com" },
      { fields: { unknown: "preserve-me" } },
    ])
      await expect(
        backend.createItem?.({ ...input(), ...extra }, session),
      ).rejects.toMatchObject({ code: "unsupported" });
    expect(fixture.requests.some((row) => row.method !== "GET")).toBe(false);
  });
  it("measures native Unicode value bytes at the exact Azure size bound", async () => {
    const { fixture, backend, session } = await setup();
    const value = "🔑".repeat(AZURE_SECRET_BYTES / 4);
    const saved = await backend.createItem?.(input("boundary", value), session);
    expect(saved?.secret).toBe(value);
    expect(backend.capabilities.vaultBackup).toEqual({
      kind: "secret",
      field: "secret",
      maxBytes: AZURE_SECRET_BYTES,
    });
    const before = fixture.requests.length;
    await expect(
      backend.createItem?.(input("too-big", `${value}x`), session),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(fixture.requests).toHaveLength(before);
  });
  it("keeps real HTTP authentication status sanitized and makes no retry", async () => {
    const { fixture, backend, session } = await setup();
    for (const status of [401, 403, 409, 429, 500]) {
      const start = fixture.requests.length;
      fixture.faultNext({
        status,
        body: {
          error: {
            code: "native-secret-body-must-not-leak",
            message: AZURE_FIXTURE_TOKEN,
          },
        },
      });
      const error = await backend
        .listItems(session)
        .catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(SecretBackendHttpError);
      expect(error).toMatchObject({
        status,
        code: status === 401 || status === 403 ? "authentication" : "response",
      });
      expect(String(error)).not.toContain(AZURE_FIXTURE_TOKEN);
      expect(String(error)).not.toContain("native-secret-body");
      expect(fixture.requests.length - start).toBe(1);
    }
  });
  it.each([
    "cross-origin",
    "other-collection",
    "cycle",
    "duplicate",
    "bad-page",
    "changed-api",
  ])("rejects %s pagination before leaking credentials", async (kind) => {
    const { fixture, backend, session } = await setup();
    fixture.seed("one", "value");
    const next = {
      "cross-origin":
        "https://attacker.invalid/secrets?api-version=2025-07-01&$skiptoken=a",
      "other-collection": `${fixture.origin}/keys?api-version=2025-07-01&$skiptoken=a`,
      cycle: `${fixture.origin}/secrets?api-version=2025-07-01&$skiptoken=a`,
      duplicate: `${fixture.origin}/secrets?api-version=2025-07-01&$skiptoken=a&$skiptoken=b`,
      "bad-page": `${fixture.origin}/secrets?api-version=2025-07-01&maxresults=26&$skiptoken=a`,
      "changed-api": `${fixture.origin}/secrets?api-version=7.1&$skiptoken=a`,
    }[kind];
    if (!next) throw new Error("Owned pagination case missing");
    fixture.nextLink(next);
    const start = fixture.requests.length;
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "response",
    });
    expect(fixture.requests.length - start).toBeLessThanOrEqual(2);
  });
  it.each([
    { value: "missing-id" },
    {
      id: "https://attacker.invalid/secrets/target/00000000000000000000000000000001",
      value: "other-vault",
    },
    { id: "/secrets/target/not-a-version", value: "relative" },
    { id: "wrong-name", value: "logical-not-version" },
    { id: "VERSION", value: 12 },
    { id: "VERSION", value: "okay", attributes: { enabled: "yes" } },
  ])("rejects malformed native bundles: %j", async (reply) => {
    const { fixture, backend, session } = await setup();
    const saved = fixture.seed("target", "legit");
    fixture.faultNext({
      body: { ...reply, id: reply.id === "VERSION" ? saved.id : reply.id },
    });
    await expect(backend.getItem("target", session)).rejects.toBeInstanceOf(
      Error,
    );
  });
  it("enforces one MiB, valid UTF-8 and JSON while cancelling malformed replies", async () => {
    const { fixture, backend, session } = await setup();
    for (const raw of [
      new Uint8Array(1024 * 1024 + 1).fill(32),
      Uint8Array.from([0xff]),
      new TextEncoder().encode("{invalid"),
    ]) {
      fixture.faultNext({ raw });
      await expect(backend.listItems(session)).rejects.toMatchObject({
        code: "response",
      });
    }
  });
  it("withdraws an exact session during a real held HTTP read and never lends a later session", async () => {
    const { fixture, backend, session } = await setup();
    fixture.seed("held", "secret");
    const held = fixture.holdNext();
    const pending = backend.getItem("held", session);
    const refusal = expect(pending).rejects.toBeInstanceOf(Error);
    await held.arrived;
    await backend.disconnect(session);
    await refusal;
    held.release();
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "authentication",
    });
    const next = await backend.authenticate(config(fixture.origin));
    expect((await backend.getItem("held", next)).secret).toBe("secret");
    await expect(backend.getItem("held", { ...next })).rejects.toMatchObject({
      code: "authentication",
    });
  });
  it("withdraws the captured owner during authentication before any session can escape", async () => {
    const fixture = await azureHttpFixture();
    fixtures.push(fixture);
    const backend = createAzureKeyVaultSecretBackend(fixture.transport);
    const held = fixture.holdNext();
    const pending = backend.authenticate(config(fixture.origin));
    const refusal = expect(pending).rejects.toMatchObject({ code: "stale" });
    await held.arrived;
    fixture.controller.abort();
    await refusal;
    held.release();
  });
  it("rejects invalid vault/token/reference inputs without HTTP", async () => {
    const { fixture, backend, session } = await setup();
    const before = fixture.requests.length;
    for (const baseUrl of [
      "https://vault.example/a",
      "https://name:password@vault.example",
      "https://vault.example?x=1",
      "http://vault.example",
    ])
      await expect(
        backend.authenticate({ ...config(fixture.origin), baseUrl }),
      ).rejects.toMatchObject({ code: "configuration" });
    await expect(
      backend.authenticate({
        ...config(fixture.origin),
        token: "Bearer token\nInjected",
      }),
    ).rejects.toMatchObject({ code: "configuration" });
    for (const reference of [
      "bad/name",
      `${fixture.origin}/keys/key`,
      `${fixture.origin}/secrets/name?query=1`,
      `${fixture.origin}/secrets/%6eame`,
      `${fixture.origin}/secrets/name/abc`,
      `${fixture.origin}/other/../secrets/name`,
      `${fixture.origin}/secrets/name#hidden`,
    ])
      await expect(backend.getItem(reference, session)).rejects.toBeInstanceOf(
        Error,
      );
    expect(fixture.requests).toHaveLength(before);
  });
  it("uses native service continuation grammar and logical IDs", () => {
    const base = azureVaultBase("https://myvault.vault.azure.net");
    expect(
      azureSecretReference(
        "https://myvault.vault.azure.net:443/secrets/Example",
        base,
      ).id,
    ).toBe("https://myvault.vault.azure.net/secrets/example");
    expect(
      azureNextPage(
        "https://myvault.vault.azure.net:443/secrets?api-version=2025-07-01&$skiptoken=opaque%2B%2F%3D&maxresults=1",
        base,
      ).origin,
    ).toBe(base.origin);
    expect(
      azureNextPage(
        "https://myvault.vault.azure.net:443/secrets?api-version=7.2&$skiptoken=opaque",
        base,
      ).searchParams.get("api-version"),
    ).toBe("7.2");
  });
  it("bounds genuine native pagination, rejects invalid delete receipts and wrong-audience tokens", async () => {
    const { fixture, backend, session } = await setup();
    await expect(
      backend.authenticate({
        ...config(fixture.origin),
        token: "wrong-audience-token",
      }),
    ).rejects.toMatchObject({ code: "authentication", status: 401 });
    fixture.seed("delete-receipt", "value");
    fixture.faultNext({
      method: "DELETE",
      body: { id: `${fixture.origin}/secrets/delete-receipt` },
    });
    await expect(
      backend.deleteItem?.("delete-receipt", session),
    ).rejects.toMatchObject({ code: "response" });
    for (let index = 0; index < 129; index++)
      fixture.seed(`bounded-${index}`, "value");
    const start = fixture.requests.length;
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "response",
    });
    expect(fixture.requests.length - start).toBe(128);
  });
});

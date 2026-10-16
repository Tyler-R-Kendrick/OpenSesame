import { afterEach, describe, expect, it } from "vitest";
import { createBitwardenSecretsBackend } from "./bitwarden-secrets.js";
import {
  accessToken,
  nativeSecretsClient,
  organizationId,
  projectId,
  secretsManagerFixture,
} from "./bitwarden-secrets.test-support.js";
import type { SecretBackendConfiguration } from "./types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function configuration(url: string): SecretBackendConfiguration {
  return {
    providerId: "bitwarden",
    name: "Secrets Manager",
    mode: "bitwarden-secrets",
    baseUrl: `${url}/api`,
    identityUrl: `${url}/identity`,
    organizationId,
    projectId,
    token: accessToken,
    vaultId: "",
    environment: "",
    secretPath: "",
    clientId: "",
    clientSecret: "",
    passwordListId: "",
    fileFormat: "",
  };
}

describe("official Bitwarden WASM with independent HTTP and cryptography", () => {
  it("authenticates the encrypted organization payload and performs authenticated encrypted CRUD", async () => {
    const server = await secretsManagerFixture();
    cleanup.push(server.close);
    const backend = createBitwardenSecretsBackend(
      undefined,
      nativeSecretsClient,
    );
    const session = await backend.authenticate(configuration(server.url));
    const created = await backend.createItem?.(
      {
        name: "API credential",
        secret: "never-send-plaintext-value",
        notes: "Encrypted note",
      },
      session,
    );
    expect(created).toMatchObject({
      name: "API credential",
      secret: "never-send-plaintext-value",
      notes: "Encrypted note",
    });
    expect(await backend.getNotes("API credential", session)).toBe(
      "Encrypted note",
    );
    if (!created) throw new Error("Missing create capability");
    expect(await backend.getItem(created.id, session)).toMatchObject({
      secret: "never-send-plaintext-value",
    });
    await backend.updateItem?.(
      created.id,
      { name: "Renamed credential", secret: "next-value", notes: "Next note" },
      session,
    );
    expect(await backend.getItem(created.id, session)).toMatchObject({
      name: "Renamed credential",
      secret: "next-value",
    });
    for (const request of server.requests) {
      expect(request.body).not.toContain("never-send-plaintext-value");
      expect(request.body).not.toContain("Encrypted note");
      expect(request.body).not.toContain(accessToken.split(":")[1]);
    }
    expect(JSON.stringify(session)).not.toContain(accessToken);
    await backend.deleteItem?.(created.id, session);
    expect(await backend.listItems(session)).toHaveLength(0);
    await backend.disconnect(session);
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "authentication",
    });
  });

  it("rejects a tampered encrypted authentication payload and invalid credentials", async () => {
    const server = await secretsManagerFixture();
    cleanup.push(server.close);
    const backend = createBitwardenSecretsBackend(
      undefined,
      nativeSecretsClient,
    );
    server.state.corruptPayload = true;
    await expect(
      backend.authenticate(configuration(server.url)),
    ).rejects.toMatchObject({ code: "response" });
    server.state.corruptPayload = false;
    server.state.rejectAuthentication = true;
    await expect(
      backend.authenticate(configuration(server.url)),
    ).rejects.toMatchObject({ code: "response" });
  });

  it("does not return plaintext when encrypted secret authentication fails", async () => {
    const server = await secretsManagerFixture();
    cleanup.push(server.close);
    const backend = createBitwardenSecretsBackend(
      undefined,
      nativeSecretsClient,
    );
    const session = await backend.authenticate(configuration(server.url));
    const created = await backend.createItem?.(
      { name: "Secret", secret: "authenticated-value", notes: "" },
      session,
    );
    if (!created) throw new Error("Missing create capability");
    server.state.corruptSecret = true;
    await expect(backend.getItem(created.id, session)).rejects.toMatchObject({
      code: "response",
    });
    await backend.disconnect(session);
  });

  it("uses configured organization/project scope and rejects forged session handles", async () => {
    const server = await secretsManagerFixture();
    cleanup.push(server.close);
    const backend = createBitwardenSecretsBackend(
      undefined,
      nativeSecretsClient,
    );
    const session = await backend.authenticate(configuration(server.url));
    const other = await backend.authenticate({
      ...configuration(server.url),
      projectId: "00000000-0000-4000-8000-000000000003",
    });
    const created = await backend.createItem?.(
      { name: "Other project", secret: "excluded", notes: "" },
      other,
    );
    expect(await backend.listItems(session)).toHaveLength(0);
    if (!created) throw new Error("Missing create capability");
    await expect(backend.getItem(created.id, session)).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(backend.listItems({ ...session })).rejects.toMatchObject({
      code: "authentication",
    });
    await backend.disconnect(session);
    await backend.disconnect(other);
  });
});

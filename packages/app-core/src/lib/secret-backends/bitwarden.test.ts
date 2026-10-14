import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createBitwardenApiBackend } from "./bitwarden.js";
import { secretHttpFixture } from "./onepassword-http.test-support.js";
import type { SecretBackendConfiguration } from "./types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const WriteSchema = z.object({
  name: z.string(),
  notes: z.string(),
  folderId: z.string().nullable(),
  type: z.number(),
  fields: z.array(
    z.object({ name: z.string(), value: z.string(), type: z.number() }),
  ),
  login: z
    .object({
      username: z.string(),
      password: z.string(),
      uris: z.array(z.object({ uri: z.string() })),
    })
    .nullable(),
  secureNote: z.object({ type: z.literal(0) }).nullable(),
});
type VaultFixtureItem = z.infer<typeof WriteSchema> & { id: string };
function configuration(baseUrl: string): SecretBackendConfiguration {
  return {
    providerId: "bitwarden",
    name: "Bitwarden API",
    mode: "bitwarden-api",
    baseUrl,
    token: "proxy-token",
    vaultId: "chosen-folder",
    projectId: "",
    organizationId: "",
    identityUrl: "",
    environment: "",
    secretPath: "",
    clientId: "",
    clientSecret: "",
    passwordListId: "",
    fileFormat: "",
  };
}
async function fixture() {
  const items = new Map<string, VaultFixtureItem>();
  const state = { status: "unlocked" };
  const server = await secretHttpFixture((request) => {
    if (request.headers.authorization !== "Bearer proxy-token")
      return { status: 401 };
    if (request.path === "/status")
      return {
        body: JSON.stringify({ success: true, data: { status: state.status } }),
      };
    if (request.path === "/list/object/items")
      return {
        body: JSON.stringify({
          success: true,
          data: { object: "list", data: [...items.values()] },
        }),
      };
    if (request.path === "/object/item" && request.method === "POST") {
      const input = WriteSchema.parse(JSON.parse(request.body));
      const item = { ...input, id: crypto.randomUUID() };
      items.set(item.id, item);
      return { body: JSON.stringify({ success: true, data: item }) };
    }
    const id = request.path.slice("/object/item/".length);
    const previous = items.get(id);
    if (!previous) return { status: 404 };
    if (request.method === "GET")
      return { body: JSON.stringify({ success: true, data: previous }) };
    if (request.method === "DELETE") {
      items.delete(id);
      return { body: '{"success":true,"data":{"object":"item"}}' };
    }
    if (request.method === "PUT") {
      const input = WriteSchema.extend({ id: z.string() }).parse(
        JSON.parse(request.body),
      );
      items.set(id, input);
      return { body: JSON.stringify({ success: true, data: input }) };
    }
    return { status: 405 };
  });
  cleanup.push(server.close);
  return { ...server, state, items };
}

describe("Bitwarden/Vaultwarden Vault Management API over real HTTP", () => {
  it("round-trips secure notes, hidden secrets and logins through the documented API envelopes", async () => {
    const server = await fixture();
    const backend = createBitwardenApiBackend();
    const session = await backend.authenticate(configuration(server.url));
    const note = await backend.createItem?.(
      {
        name: "Backup",
        notes: "encrypted-vault-data",
        secret: "recovery-key",
        kind: "note",
      },
      session,
    );
    expect(note).toMatchObject({
      kind: "note",
      notes: "encrypted-vault-data",
      secret: "recovery-key",
    });
    expect(await backend.getNotes("Backup", session)).toBe(
      "encrypted-vault-data",
    );
    const login = await backend.createItem?.(
      {
        name: "Login",
        notes: "Account note",
        secret: "password",
        username: "alice",
        url: "https://example.com",
        kind: "login",
        fields: { team: "Platform" },
      },
      session,
    );
    expect(login).toMatchObject({
      kind: "login",
      username: "alice",
      secret: "password",
      url: "https://example.com",
      fields: { team: "Platform" },
    });
    if (!note) throw new Error("Missing create capability");
    await backend.updateItem?.(
      note.id,
      {
        name: "Updated backup",
        notes: "next-encrypted-data",
        secret: "recovery-key",
      },
      session,
    );
    expect(await backend.getNotes(note.id, session)).toBe(
      "next-encrypted-data",
    );
    await backend.deleteItem?.(note.id, session);
    expect(await backend.listItems(session)).toHaveLength(1);
    await backend.disconnect(session);
    await expect(backend.getNotes("Login", session)).rejects.toMatchObject({
      code: "authentication",
    });
    expect(server.requests.some((request) => request.path === "/lock")).toBe(
      false,
    );
  });

  it("refuses locked vaults and duplicate names", async () => {
    const server = await fixture();
    const backend = createBitwardenApiBackend();
    server.state.status = "locked";
    await expect(
      backend.authenticate(configuration(server.url)),
    ).rejects.toMatchObject({ code: "locked" });
    server.state.status = "unlocked";
    const session = await backend.authenticate(configuration(server.url));
    for (let i = 0; i < 2; i++)
      await backend.createItem?.(
        { name: "Duplicate", notes: String(i), secret: "" },
        session,
      );
    await expect(backend.getNotes("Duplicate", session)).rejects.toMatchObject({
      code: "ambiguous",
    });
  });

  it("scopes item reads, updates and deletions to the selected folder", async () => {
    const server = await fixture();
    const backend = createBitwardenApiBackend();
    const session = await backend.authenticate(configuration(server.url));
    const external = await backend.authenticate({
      ...configuration(server.url),
      vaultId: "other-folder",
    });
    const item = await backend.createItem?.(
      { name: "Other folder", notes: "excluded", secret: "" },
      external,
    );
    if (!item) throw new Error("Missing create capability");
    expect(await backend.listItems(session)).toHaveLength(0);
    await expect(backend.getItem(item.id, session)).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(backend.deleteItem?.(item.id, session)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("does not accept a reconstructed session or leak upstream credential error details", async () => {
    const server = await fixture();
    const backend = createBitwardenApiBackend();
    await expect(
      backend.authenticate({
        ...configuration(server.url),
        token: "bad-token",
      }),
    ).rejects.toMatchObject({ code: "authentication" });
    const session = await backend.authenticate(configuration(server.url));
    expect(JSON.stringify(session)).not.toContain("proxy-token");
    await expect(backend.listItems({ ...session })).rejects.toMatchObject({
      code: "authentication",
    });
  });
});

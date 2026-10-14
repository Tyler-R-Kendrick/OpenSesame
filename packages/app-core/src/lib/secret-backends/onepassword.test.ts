import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { secretHttpFixture } from "./onepassword-http.test-support.js";
import { createOnePasswordConnectBackend } from "./onepassword.js";
import type { SecretBackendConfiguration } from "./types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const WriteSchema = z.object({
  title: z.string(),
  category: z.string(),
  vault: z.object({ id: z.string() }),
  fields: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      purpose: z.string().optional(),
      label: z.string().optional(),
      value: z.string(),
    }),
  ),
  urls: z.array(z.object({ href: z.string() })),
});
type ConnectFixtureItem = z.infer<typeof WriteSchema> & {
  id: string;
  version: number;
};
function configuration(baseUrl: string): SecretBackendConfiguration {
  return {
    providerId: "onepassword",
    name: "1Password",
    mode: "onepassword-connect",
    baseUrl,
    token: "connect-token",
    vaultId: "selected-vault",
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
  const items = new Map<string, ConnectFixtureItem>();
  const server = await secretHttpFixture((request) => {
    if (request.headers.authorization !== "Bearer connect-token")
      return { status: 401, body: '{"message":"credential echo forbidden"}' };
    if (request.path === "/v1/vaults/selected-vault")
      return { body: '{"id":"selected-vault","name":"Backups"}' };
    const root = "/v1/vaults/selected-vault/items";
    if (request.path === root && request.method === "GET")
      return {
        body: JSON.stringify(
          [...items.values()].map(({ id, title, category }) => ({
            id,
            title,
            category,
          })),
        ),
      };
    if (request.path === root && request.method === "POST") {
      const input = WriteSchema.parse(JSON.parse(request.body));
      if (input.vault.id !== "selected-vault") return { status: 400 };
      const item = { ...input, id: crypto.randomUUID(), version: 1 };
      items.set(item.id, item);
      return { status: 201, body: JSON.stringify(item) };
    }
    const id = request.path.slice(root.length + 1);
    const previous = items.get(id);
    if (!previous) return { status: 404 };
    if (request.method === "GET") return { body: JSON.stringify(previous) };
    if (request.method === "DELETE") {
      items.delete(id);
      return { status: 204 };
    }
    if (request.method === "PUT") {
      const input = WriteSchema.extend({
        id: z.string(),
        version: z.number(),
      }).parse(JSON.parse(request.body));
      if (input.version !== previous.version || input.id !== id)
        return { status: 409 };
      const item = { ...input, version: previous.version + 1 };
      items.set(id, item);
      return { body: JSON.stringify(item) };
    }
    return { status: 405 };
  });
  cleanup.push(server.close);
  return { ...server, items };
}

describe("1Password Connect over real HTTP", () => {
  it("authenticates the selected vault and creates, reads, updates and deletes protected notes", async () => {
    const server = await fixture();
    const backend = createOnePasswordConnectBackend();
    const session = await backend.authenticate(configuration(server.url));
    expect(JSON.stringify(session)).not.toContain("connect-token");
    const created = await backend.createItem?.(
      {
        name: "Encrypted vault backup",
        notes: "encrypted-backup-contents",
        secret: "",
        kind: "note",
      },
      session,
    );
    expect(created).toMatchObject({
      name: "Encrypted vault backup",
      notes: "encrypted-backup-contents",
      kind: "note",
    });
    expect(await backend.getNotes("Encrypted vault backup", session)).toBe(
      "encrypted-backup-contents",
    );
    expect(await backend.listItems(session)).toHaveLength(1);
    if (!created) throw new Error("Create capability missing");
    await backend.updateItem?.(
      created.id,
      {
        name: created.name,
        notes: "updated-backup",
        secret: "new-secret",
        kind: "note",
      },
      session,
    );
    expect(await backend.getItem(created.id, session)).toMatchObject({
      notes: "updated-backup",
      secret: "new-secret",
    });
    await backend.deleteItem?.(created.id, session);
    await expect(backend.getItem(created.id, session)).rejects.toMatchObject({
      code: "not-found",
    });
    await backend.disconnect(session);
    await expect(backend.listItems(session)).rejects.toMatchObject({
      code: "authentication",
    });
  });

  it("round-trips login and custom fields without exposing token material in summaries", async () => {
    const server = await fixture();
    const backend = createOnePasswordConnectBackend();
    const session = await backend.authenticate(configuration(server.url));
    const created = await backend.createItem?.(
      {
        name: "Login",
        notes: "Account note",
        secret: "password-value",
        kind: "login",
        username: "alice",
        url: "https://example.com",
        fields: { team: "Platform" },
      },
      session,
    );
    expect(created).toMatchObject({
      username: "alice",
      secret: "password-value",
      url: "https://example.com",
      fields: { team: "Platform" },
    });
    expect(JSON.stringify(await backend.listItems(session))).not.toContain(
      "password-value",
    );
  });

  it("rejects duplicate names while exact item IDs remain usable", async () => {
    const server = await fixture();
    const backend = createOnePasswordConnectBackend();
    const session = await backend.authenticate(configuration(server.url));
    const first = await backend.createItem?.(
      { name: "Duplicate", notes: "one", secret: "" },
      session,
    );
    await backend.createItem?.(
      { name: "Duplicate", notes: "two", secret: "" },
      session,
    );
    await expect(backend.getNotes("Duplicate", session)).rejects.toMatchObject({
      code: "ambiguous",
    });
    if (!first) throw new Error("Create capability missing");
    expect(await backend.getNotes(first.id, session)).toBe("one");
  });

  it("rejects bad credentials and forged or cross-instance session handles", async () => {
    const server = await fixture();
    const backend = createOnePasswordConnectBackend();
    await expect(
      backend.authenticate({ ...configuration(server.url), token: "wrong" }),
    ).rejects.toMatchObject({ code: "authentication" });
    const session = await backend.authenticate(configuration(server.url));
    await expect(backend.listItems({ ...session })).rejects.toMatchObject({
      code: "authentication",
    });
    await expect(
      createOnePasswordConnectBackend().listItems(session),
    ).rejects.toMatchObject({ code: "authentication" });
  });
});

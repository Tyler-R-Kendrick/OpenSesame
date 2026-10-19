import { afterEach, expect, it } from "vitest";
import {
  NATIVE_LIMITS,
  NATIVE_PASSWORD,
  nativeHttpFixture,
} from "./bitwarden-native-http.test-support.js";
import {
  type BitwardenNativeConfiguration,
  createBitwardenNativeBackend,
} from "./bitwarden-native.js";
import type { SecretBackend, SecretBackendSession } from "./types.js";

type Fixture = Awaited<ReturnType<typeof nativeHttpFixture>>;
const fixtures: Fixture[] = [];
const sessions: { backend: SecretBackend; session: SecretBackendSession }[] =
  [];
afterEach(async () => {
  for (const open of sessions.splice(0))
    await open.backend.disconnect(open.session);
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
function configuration(fixture: Fixture): BitwardenNativeConfiguration {
  return {
    providerId: fixture.modern ? "bitwarden" : "vaultwarden",
    name: "Owned native account",
    mode: "bitwarden-api",
    ...fixture.credentials,
    accountEmail: fixture.credentials.email,
    masterPassword: NATIVE_PASSWORD,
    token: "",
    vaultId: "",
    projectId: "",
    organizationId: "",
    environment: "",
    secretPath: "",
    passwordListId: "",
    fileFormat: "",
  };
}
async function connected(modern: boolean, folder = "") {
  const fixture = await nativeHttpFixture(modern);
  fixtures.push(fixture);
  const backend = createBitwardenNativeBackend(
    fixture.transport,
    NATIVE_LIMITS,
  );
  const config = configuration(fixture);
  config.vaultId = folder;
  const session = await backend.authenticate(config);
  sessions.push({ backend, session });
  return { fixture, backend, config, session };
}
it.each([false, true])(
  "fulfills common SecretBackend encrypted note/login/secret CRUD and verified read-back modern=%s",
  async (modern) => {
    const { fixture, backend, session } = await connected(modern);
    expect(backend.capabilities).toMatchObject({
      create: true,
      get: true,
      update: true,
      delete: true,
      vaultBackup: { kind: "note", field: "notes" },
    });
    expect(JSON.stringify(session)).not.toContain(NATIVE_PASSWORD);
    expect(Object.isFrozen(session)).toBe(true);
    for (const kind of ["note", "login", "secret"] as const) {
      const input = {
        kind,
        name: `Owned ${kind} 🔐`,
        notes: "Confidential note contents",
        secret: "Confidential secret contents",
        username: "owner",
        url: "https://owned.example.test",
      };
      const created = await backend.createItem?.(input, session);
      if (!created) throw new Error("Missing required create operation.");
      expect(created).toMatchObject({
        name: input.name,
        notes: input.notes,
        secret: input.secret,
        kind,
      });
      expect(await backend.getItem(created.name, session)).toEqual(created);
      expect(await backend.getNotes(created.id, session)).toBe(input.notes);
      const replacement = {
        ...input,
        name: `Updated ${kind} 🔐`,
        notes: "Updated confidential note",
        secret: "Updated confidential secret",
      };
      expect(
        await backend.updateItem?.(created.id, replacement, session),
      ).toMatchObject({
        name: replacement.name,
        notes: replacement.notes,
        secret: replacement.secret,
        kind,
      });
      expect(await backend.listItems(session)).toEqual([
        { id: created.id, name: replacement.name, kind },
      ]);
      expect(fixture.decoded.get(created.id)?.get("notes")).toBe(
        replacement.notes,
      );
      await backend.deleteItem?.(created.id, session);
      expect(await backend.listItems(session)).toEqual([]);
      expect(fixture.items.get(created.id)?.deletedDate).toBeDefined();
    }
    for (const request of fixture.requests.filter(
      (record) =>
        record.path.startsWith("/api/ciphers") && record.method !== "GET",
    )) {
      expect(request.body).not.toContain("Confidential");
      expect(request.body).not.toContain("confidential");
      expect(request.body).not.toContain(NATIVE_PASSWORD);
    }
  },
);
it("keeps duplicate names selectable by ID and refuses ambiguous name lookups", async () => {
  const { backend, session } = await connected(false);
  const input = { name: "Duplicate name", notes: "Owned note", secret: "" };
  const first = await backend.createItem?.(input, session);
  const second = await backend.createItem?.(input, session);
  if (!first || !second) throw new Error("Missing create operation.");
  await expect(backend.getItem(input.name, session)).rejects.toMatchObject({
    code: "ambiguous",
  });
  expect((await backend.getItem(first.id, session)).id).toBe(first.id);
  expect(second.id).not.toBe(first.id);
});
it.each(["update", "delete"])(
  "detects changed remote revision before %s and dispatches no write",
  async (operation) => {
    const { fixture, backend, session } = await connected(true);
    const input = {
      name: "Concurrent edit",
      notes: "Owned original",
      secret: "",
    };
    const row = await backend.createItem?.(input, session);
    if (!row) throw new Error("Missing create operation.");
    const stored = fixture.items.get(row.id);
    if (!stored) throw new Error("Missing independently stored row.");
    stored.revisionDate = "2026-10-02T00:00:00Z";
    const count = fixture.requests.length;
    const pending =
      operation === "update"
        ? backend.updateItem?.(
            row.id,
            { ...input, notes: "Would overwrite" },
            session,
          )
        : backend.deleteItem?.(row.id, session);
    await expect(pending).rejects.toThrow(/changed remotely/);
    expect(
      fixture.requests.slice(count).some((request) => request.method === "PUT"),
    ).toBe(false);
    expect(session.signal?.aborted).toBe(true);
  },
);
it("keeps unrelated/org/deleted items untouched while operating inside an explicit personal folder", async () => {
  const folder = "3c290371-6d6c-4b9d-b073-ac971bca8a01";
  const { fixture, backend, session } = await connected(false, folder);
  const row = await backend.createItem?.(
    { name: "Scoped note", notes: "Owned scope", secret: "" },
    session,
  );
  if (!row) throw new Error("Missing create operation.");
  fixture.state.extraCiphers.push(
    {
      id: "d17df7f7-ce73-4290-96d6-71096183e891",
      type: 1,
      organizationId: folder,
      name: "not a decrypted plaintext result",
    },
    {
      id: "e3cbfd59-4456-4e8f-a307-d3ab07ca8469",
      type: 3,
      organizationId: null,
      folderId: folder,
      name: "unrelated card",
    },
  );
  const snapshot = JSON.stringify(fixture.state.extraCiphers);
  expect(await backend.listItems(session)).toEqual([
    { id: row.id, name: row.name, kind: "note" },
  ]);
  await backend.updateItem?.(
    row.id,
    { name: row.name, notes: "Scoped update", secret: "" },
    session,
  );
  expect(JSON.stringify(fixture.state.extraCiphers)).toBe(snapshot);
});
it("withdraws a held fresh read before mutation, closes the public session and sends no late write", async () => {
  const { fixture, backend, session } = await connected(true);
  const input = { name: "Held item", notes: "Owned value", secret: "" };
  const row = await backend.createItem?.(input, session);
  if (!row) throw new Error("Missing create operation.");
  const held = fixture.hold(`/api/ciphers/${row.id}`, "GET");
  const count = fixture.requests.length;
  const updating = backend.updateItem?.(
    row.id,
    { ...input, notes: "Held replacement" },
    session,
  );
  await held.ready;
  fixture.controller.abort();
  await expect(updating).rejects.toBeDefined();
  held.release();
  expect(session.signal?.aborted).toBe(true);
  expect(
    fixture.requests.slice(count).some((request) => request.method === "PUT"),
  ).toBe(false);
  await expect(backend.getItem(row.id, session)).rejects.toBeDefined();
});
it("refuses forged handles and missing transient unlock fields; disconnect ends the exact owner", async () => {
  const { fixture, backend, session, config } = await connected(false);
  await expect(backend.listItems({ ...session })).rejects.toMatchObject({
    code: "authentication",
  });
  const count = fixture.requests.length;
  const missing: BitwardenNativeConfiguration = {
    ...config,
    masterPassword: "",
  };
  await expect(backend.authenticate(missing)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(fixture.requests.length).toBe(count);
  await backend.disconnect(session);
  expect(session.signal?.aborted).toBe(true);
  await expect(backend.listItems(session)).rejects.toBeDefined();
});

import { afterEach, beforeEach, expect, it } from "vitest";
import { kvGet } from "../kv.js";
import { VaultStore } from "../vault/store.js";
import { BODY_PATH, tombFileKey } from "../vfs.js";
import { createFileImportBackend } from "./file-import.js";
import { bitwardenExport } from "./file-import.test-support.js";
import { createLocalVaultBackend } from "./local.js";
import { secretBackendDraft } from "./presets.js";

let store: VaultStore;
beforeEach(async () => {
  store = new VaultStore();
  await store.createGuest();
});
afterEach(() => store.lock());

it("stores actual sealed vault items and CRUD works without plaintext storage", async () => {
  const backend = createLocalVaultBackend(store);
  const session = await backend.authenticate(
    secretBackendDraft("byo-secret-backend"),
  );
  const input = {
    name: "Deploy secret",
    kind: "secret" as const,
    secret: "local-secret-fixture",
    notes: "private-note-fixture",
  };
  const item = await backend.createItem?.(input, session);
  if (!item) throw new Error("Expected local create capability");
  expect(await backend.listItems(session)).toEqual([
    { id: item.id, name: input.name, kind: "secret" },
  ]);
  expect(await backend.getNotes(item.id, session)).toBe(input.notes);
  expect(await backend.getItem(input.name, session)).toMatchObject(input);
  const stored = store.getSnapshot().items.find((held) => held.id === item.id);
  expect(stored).toMatchObject({ kind: "secret", value: input.secret });
  await store.flushPendingWrites();
  const sealed = kvGet(tombFileKey(store.getSnapshot().tomb, BODY_PATH));
  expect(sealed).toBeTruthy();
  expect(sealed).not.toContain(input.secret);
  expect(sealed).not.toContain(input.notes);
  await backend.updateItem?.(
    item.id,
    { ...input, secret: "rotated-fixture" },
    session,
  );
  expect((await backend.getItem(item.id, session)).secret).toBe(
    "rotated-fixture",
  );
  await backend.deleteItem?.(item.id, session);
  expect(await backend.listItems(session)).toEqual([]);
  await expect(backend.getItem(item.id, session)).rejects.toMatchObject({
    code: "not-found",
  });
});

it("a durable vault reloads the saved login through its existing password credential model", async () => {
  store.lock();
  const password = "correct horse battery staple for backend test";
  const durable = new VaultStore();
  await durable.create(password);
  const backend = createLocalVaultBackend(durable);
  const session = await backend.authenticate(
    secretBackendDraft("byo-secret-backend"),
  );
  const saved = await backend.createItem?.(
    {
      name: "Login",
      kind: "login",
      username: "user",
      url: "https://example.com",
      secret: "login-password-fixture",
      notes: "login notes",
    },
    session,
  );
  if (!saved) throw new Error("Expected a saved login");
  const importer = createFileImportBackend(durable);
  const importedSession = await importer.authenticate({
    ...secretBackendDraft("bitwarden"),
    mode: "file-import",
    fileFormat: "bitwarden-json",
    file: new File([bitwardenExport], "bitwarden.json"),
  });
  expect(await importer.importToLocal?.(importedSession)).toMatchObject({
    imported: 1,
  });
  await importer.disconnect(importedSession);
  await durable.flushPendingWrites();
  durable.lock();
  await expect(backend.getItem(saved.id, session)).rejects.toMatchObject({
    code: "stale",
  });
  const restored = new VaultStore();
  await restored.unlock(password);
  try {
    const reopened = createLocalVaultBackend(restored);
    const next = await reopened.authenticate(
      secretBackendDraft("byo-secret-backend"),
    );
    expect(await reopened.getItem(saved.id, next)).toMatchObject({
      name: "Login",
      username: "user",
      secret: "login-password-fixture",
    });
    expect(await reopened.getItem("Imported Login", next)).toMatchObject({
      secret: "import-password-fixture",
      notes: "import-note-fixture",
    });
    expect(
      restored.getSnapshot().folders.map((folder) => folder.name),
    ).toContain("Imported folder");
  } finally {
    restored.lock();
  }
});

it("name collisions require IDs and copied or revoked sessions cannot read", async () => {
  const backend = createLocalVaultBackend(store);
  const session = await backend.authenticate(
    secretBackendDraft("byo-secret-backend"),
  );
  const a = await backend.createItem?.(
    { name: "Same", notes: "a", secret: "a" },
    session,
  );
  await backend.createItem?.(
    { name: "Same", notes: "b", secret: "b" },
    session,
  );
  await expect(backend.getItem("Same", session)).rejects.toMatchObject({
    code: "ambiguous",
  });
  expect((await backend.getItem(a?.id ?? "", session)).notes).toBe("a");
  await expect(backend.listItems({ ...session })).rejects.toMatchObject({
    code: "authentication",
  });
  await backend.disconnect(session);
  await expect(backend.listItems(session)).rejects.toMatchObject({
    code: "authentication",
  });
});

it("locked or second-step-pending vaults cannot authenticate", async () => {
  store.lock();
  const backend = createLocalVaultBackend(store);
  await expect(
    backend.authenticate(secretBackendDraft("byo-secret-backend")),
  ).rejects.toMatchObject({ code: "locked" });
});

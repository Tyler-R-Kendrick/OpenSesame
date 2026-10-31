import { overlapCast } from "@opensesame/os-domain";
import {
  type VaultItem,
  createItem,
  createVault,
  outsideAccounts,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import { PERSONAL_TOMB, readFile } from "../vfs.js";
import {
  BODY_KEY,
  HEADER_KEY,
  PASSWORD,
  clearVault,
  installStoreOperationsFixture,
  newStore,
  unlockedStore,
} from "./store-ops.fixture.js";
import {
  ATTEMPTS_KEY,
  PREFS_CONFIG_PATH,
  VaultCorruptError,
  WrongPasswordError,
  assertMasterPasswordPolicy,
  normalizeVaultPrefs,
} from "./store.js";
import { LEGACY_PREFS_KEY } from "./tomb-migration.js";

installStoreOperationsFixture();

describe("assertMasterPasswordPolicy", () => {
  it("rejects short passwords and easy guesses", () => {
    expect(() => assertMasterPasswordPolicy("short")).toThrow(
      /at least 12 characters/,
    );
    expect(() => assertMasterPasswordPolicy("aaaaaaaaaaaa")).toThrow(
      /too easy to guess/,
    );
    expect(() => assertMasterPasswordPolicy(PASSWORD)).not.toThrow();
  });
});

describe("normalizeVaultPrefs edge cases", () => {
  it("tolerates null and partial input", () => {
    expect(normalizeVaultPrefs(null).theme).toBe("system");
    expect(normalizeVaultPrefs(undefined).clipboardClearSeconds).toBe(30);
  });

  it("clamps a nonsense auto-lock to Never", () => {
    expect(normalizeVaultPrefs({ autoLockMinutes: -5 }).autoLockMinutes).toBe(
      0,
    );
    expect(
      normalizeVaultPrefs({ autoLockMinutes: Number.NaN }).autoLockMinutes,
    ).toBe(0);
    expect(
      normalizeVaultPrefs({
        autoLockMinutes: overlapCast("soon"),
      }).autoLockMinutes,
    ).toBe(0);
  });

  it("forces a non-boolean signOutOnLock back off", () => {
    expect(
      normalizeVaultPrefs({
        signOutOnLock: overlapCast("yes"),
      }).signOutOnLock,
    ).toBe(false);
  });
});

describe("VaultStore item mutations", () => {
  it("adds, updates, trashes, restores, and purges items", async () => {
    const store = await unlockedStore();
    const item = createItem("account", "Mail");
    await store.saveItem(item);
    expect(outsideAccounts(store.getSnapshot().items)).toHaveLength(1);
    const renamed = { ...item, name: "Mail (work)" };
    await store.saveItem(renamed);
    expect(outsideAccounts(store.getSnapshot().items)).toHaveLength(1);
    expect(store.getSnapshot().items[0]?.name).toBe("Mail (work)");
    await store.trashItem(item.id);
    expect(store.getSnapshot().items[0]?.deletedAt).not.toBeNull();

    await store.restoreItem(item.id);
    expect(store.getSnapshot().items[0]?.deletedAt).toBeNull();

    await store.trashItem(item.id);
    await store.purgeItem(item.id);
    expect(store.getSnapshot().items).toHaveLength(0);
  });

  it("empties the trash but keeps live items", async () => {
    const store = await unlockedStore();
    const keep = createItem("note", "Keep");
    const drop = createItem("note", "Drop");
    await store.addItems([keep, drop]);
    await store.trashItem(drop.id);
    await store.emptyTrash();
    expect(store.getSnapshot().items.map((item) => item.name)).toEqual([
      "Keep",
    ]);
  });

  it("toggles favorites", async () => {
    const store = await unlockedStore();
    const item = createItem("note", "Fav");
    await store.saveItem(item);
    await store.toggleFavorite(item.id);
    expect(store.getSnapshot().items[0]?.favorite).toBe(true);
    await store.toggleFavorite(item.id);
    expect(store.getSnapshot().items[0]?.favorite).toBe(false);
  });

  it("replaces the whole collection", async () => {
    const store = await unlockedStore();
    await store.saveItem(createItem("note", "Old"));
    const folder = await store.addFolder("Fresh");
    await store.replaceAll([createItem("note", "New")], [folder]);
    expect(store.getSnapshot().items.map((item) => item.name)).toEqual(["New"]);
    expect(store.getSnapshot().folders.map((f) => f.name)).toEqual(["Fresh"]);
  });

  it("stamps updatedAt when an existing item is saved", async () => {
    const store = await unlockedStore();
    const item = createItem("note", "Stamp");
    item.updatedAt = "2000-01-01T00:00:00.000Z";
    await store.saveItem(item);
    const saved = store.getSnapshot().items[0];
    expect(saved?.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
  });
});

describe("VaultStore folders", () => {
  it("trims folder names and renames them", async () => {
    const store = await unlockedStore();
    const folder = await store.addFolder("  Personal  ");
    expect(folder.name).toBe("Personal");

    await store.renameFolder(folder.id, "  Work  ");
    expect(store.getSnapshot().folders[0]?.name).toBe("Work");
  });

  it("orphans items when their folder is deleted", async () => {
    const store = await unlockedStore();
    const folder = await store.addFolder("Soon gone");
    const item = createItem("note", "Orphan");
    item.folderId = folder.id;
    await store.saveItem(item);

    await store.deleteFolder(folder.id);
    expect(store.getSnapshot().folders).toHaveLength(0);
    expect(store.getSnapshot().items[0]?.folderId).toBeNull();
  });
});

describe("VaultStore import plans", () => {
  it("applies an import plan atomically and reports the count", async () => {
    const store = await unlockedStore();
    const folder = {
      id: crypto.randomUUID(),
      name: "Imported",
      createdAt: new Date().toISOString(),
    };
    const count = await store.applyImport({
      items: [createItem("account", "One"), createItem("note", "Two")],
      newFolders: [folder],
    });
    expect(count).toBe(2);
    expect(outsideAccounts(store.getSnapshot().items)).toHaveLength(2);
    expect(store.getSnapshot().folders).toHaveLength(1);

    await expect(
      store.applyImport({ items: [], newFolders: [] }),
    ).resolves.toBe(0);
  });

  it("applies a manifest merge with adds, updates, and new folders", async () => {
    const store = await unlockedStore();
    const existing = createItem("account", "Existing");
    await store.saveItem(existing);

    const updated: VaultItem = { ...existing, notes: "from manifest" };
    const added = createItem("account", "Added");
    const newFolder = {
      id: crypto.randomUUID(),
      name: "Manifest",
      createdAt: new Date().toISOString(),
    };
    await store.applyManifestMerge({
      adds: [added],
      updates: [updated],
      newFolders: [newFolder],
    });

    const names = outsideAccounts(store.getSnapshot().items)
      .map((item) => item.name)
      .sort();
    expect(names).toEqual(["Added", "Existing"]);
    expect(
      store.getSnapshot().items.find((item) => item.id === existing.id)?.notes,
    ).toBe("from manifest");
    expect(store.getSnapshot().folders).toHaveLength(1);
  });

  it("ignores an empty manifest merge plan", async () => {
    const store = await unlockedStore();
    const before = store.getSnapshot();
    await store.applyManifestMerge({ adds: [], updates: [], newFolders: [] });
    expect(store.getSnapshot()).toBe(before);
  });
});

describe("VaultStore sealed export and import", () => {
  it("refuses to export what is not there", () => {
    const store = newStore();
    expect(() => store.exportSealed()).toThrow(/no vault to export/);
  });

  it("round-trips items through an encrypted export", async () => {
    const source = await unlockedStore();
    const item = createItem("account", "Portable");
    await source.saveItem(item);
    const exported = source.exportSealed();

    // A second device: same password, empty vault.
    clearVault();
    const target = await unlockedStore();
    await expect(target.importSealed(exported, PASSWORD)).resolves.toBe(1);
    expect(
      outsideAccounts(target.getSnapshot().items).map((i) => i.name),
    ).toEqual(["Portable"]);

    // Importing the same file again merges nothing.
    await expect(target.importSealed(exported, PASSWORD)).resolves.toBe(0);
  });

  it("rejects files that are not vault exports", async () => {
    const store = await unlockedStore();
    await expect(store.importSealed("not json {{{", PASSWORD)).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(
      store.importSealed(
        JSON.stringify({ format: "something-else" }),
        PASSWORD,
      ),
    ).rejects.toThrow(/not an OpenSesame vault export/);
  });

  it("rejects the wrong password for the export", async () => {
    const source = await unlockedStore();
    await source.saveItem(createItem("note", "Secret"));
    const exported = source.exportSealed();
    await expect(
      source.importSealed(exported, "definitely wrong password"),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe("VaultStore session lifecycle", () => {
  it("notifies subscribers until they unsubscribe", async () => {
    const store = newStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    await store.create(PASSWORD);
    const afterCreate = calls;
    expect(afterCreate).toBeGreaterThan(0);

    unsubscribe();
    store.lock();
    expect(calls).toBe(afterCreate);
  });

  it("runs lock handlers and supports removing them", async () => {
    const store = await unlockedStore();
    let locks = 0;
    const off = store.onLock(() => {
      locks += 1;
    });
    store.lock();
    expect(locks).toBe(1);
    off();
    store.lock();
    expect(locks).toBe(1);
  });

  it("refuses to unlock a vault that does not exist", async () => {
    const store = newStore();
    await expect(store.unlock(PASSWORD)).rejects.toThrow(/no vault/);
    await expect(store.unlockWithPin("48291037")).rejects.toThrow(/no vault/);
    await expect(store.unlockWithPasskey()).rejects.toThrow(/no vault/);
  });

  it("fails PIN unlock like a wrong secret when no PIN is enrolled", async () => {
    const store = await unlockedStore();
    store.lock();
    await expect(store.unlockWithPin("48291037")).rejects.toThrow(
      /did not unlock/,
    );
  });

  it("honors a recorded lockout instead of trying the password", async () => {
    const { header } = await createVault(PASSWORD);
    kvSet(HEADER_KEY, JSON.stringify(header));
    kvSet(
      ATTEMPTS_KEY,
      JSON.stringify({ fails: 5, until: Date.now() + 30_000 }),
    );
    const store = newStore();
    expect(store.getSnapshot().lockedOutUntil).not.toBeNull();
    await expect(store.unlock(PASSWORD)).rejects.toThrow(/Too many attempts/);
    await expect(store.unlockWithPin("48291037")).rejects.toThrow(
      /Too many attempts/,
    );
    await expect(store.confirmTotp("123456")).rejects.toThrow(
      /Too many attempts/,
    );
  });

  it("calls a tampered body corrupt, not the password wrong", async () => {
    const store = await unlockedStore();
    await store.saveItem(createItem("note", "Kept"));
    store.lock();
    // Not something this vault key can open.
    kvSet(BODY_KEY, JSON.stringify({ ivB64: "AAAA", ctB64: "AAAA" }));
    const reopened = newStore();
    await expect(reopened.unlock(PASSWORD)).rejects.toBeInstanceOf(
      VaultCorruptError,
    );
  });

  it("rehydrates a header that appeared after construction", async () => {
    const store = newStore();
    expect(store.getSnapshot().status).toBe("empty");
    const { header } = await createVault(PASSWORD);
    kvSet(HEADER_KEY, JSON.stringify(header));
    store.rehydrate();
    expect(store.getSnapshot().status).toBe("locked");
  });

  it("does not rehydrate over an unlocked session", async () => {
    const store = await unlockedStore();
    kvDelete(HEADER_KEY);
    store.rehydrate();
    expect(store.getSnapshot().status).toBe("unlocked");
  });

  it("persists migrated prefs once for old installs", async () => {
    // Legacy plaintext prefs seal into the tomb config on unlock; the legacy key is then gone.
    kvSet(
      LEGACY_PREFS_KEY,
      JSON.stringify({ autoLockMinutes: 15, theme: "dark" }),
    );
    const store = newStore();
    await store.create(PASSWORD);
    expect(store.getSnapshot().prefs.autoLockMinutes).toBe(0);
    expect(store.getSnapshot().prefs.theme).toBe("dark");
    expect(kvGet(LEGACY_PREFS_KEY)).toBeNull();
    const sealed = await readFile(PERSONAL_TOMB, PREFS_CONFIG_PATH);
    const stored: Partial<{ prefsRevision: number }> = overlapCast(
      JSON.parse(new TextDecoder().decode(sealed)),
    );
    expect(stored.prefsRevision).toBeGreaterThanOrEqual(2);
  });
});

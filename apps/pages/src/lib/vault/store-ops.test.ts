import { overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import { createVault } from "./crypto.js";
import { type VaultItem, createItem } from "./model.js";
import {
  ATTEMPTS_KEY,
  BODY_KEY,
  HEADER_KEY,
  PREFS_KEY,
  VaultCorruptError,
  VaultStore,
  WrongPasswordError,
  assertMasterPasswordPolicy,
  normalizeVaultPrefs,
} from "./store.js";

const PASSWORD = "correct horse battery staple";
const NEXT_PASSWORD = "fourteen ungulate carriage nail";

function clearVault(): void {
  kvDelete(ATTEMPTS_KEY);
  kvDelete(HEADER_KEY);
  kvDelete(BODY_KEY);
  kvDelete(PREFS_KEY);
}

async function unlockedStore(): Promise<VaultStore> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  return store;
}

beforeEach(clearVault);

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
    const item = createItem("login", "Mail");
    await store.saveItem(item);
    expect(store.getSnapshot().items).toHaveLength(1);

    const renamed = { ...item, name: "Mail (work)" };
    await store.saveItem(renamed);
    expect(store.getSnapshot().items).toHaveLength(1);
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
      items: [createItem("login", "One"), createItem("note", "Two")],
      newFolders: [folder],
    });
    expect(count).toBe(2);
    expect(store.getSnapshot().items).toHaveLength(2);
    expect(store.getSnapshot().folders).toHaveLength(1);

    await expect(
      store.applyImport({ items: [], newFolders: [] }),
    ).resolves.toBe(0);
  });

  it("applies a manifest merge with adds, updates, and new folders", async () => {
    const store = await unlockedStore();
    const existing = createItem("login", "Existing");
    await store.saveItem(existing);

    const updated: VaultItem = { ...existing, notes: "from manifest" };
    const added = createItem("login", "Added");
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

    const names = store
      .getSnapshot()
      .items.map((item) => item.name)
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
    const store = new VaultStore();
    expect(() => store.exportSealed()).toThrow(/no vault to export/);
  });

  it("round-trips items through an encrypted export", async () => {
    const source = await unlockedStore();
    const item = createItem("login", "Portable");
    await source.saveItem(item);
    const exported = source.exportSealed();

    // A second device: same password, empty vault.
    clearVault();
    const target = new VaultStore();
    await target.create(PASSWORD);
    await expect(target.importSealed(exported, PASSWORD)).resolves.toBe(1);
    expect(target.getSnapshot().items.map((i) => i.name)).toEqual(["Portable"]);

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

describe("VaultStore destroy", () => {
  it("removes every trace and reports an empty vault afterwards", async () => {
    const store = await unlockedStore();
    await store.saveItem(createItem("note", "Gone"));
    await store.destroy();

    expect(kvGet(HEADER_KEY)).toBeNull();
    expect(kvGet(BODY_KEY)).toBeNull();
    expect(store.getSnapshot().status).toBe("empty");
    expect(store.isUnlocked()).toBe(false);
    expect(new VaultStore().getSnapshot().status).toBe("empty");
  });
});

describe("VaultStore session lifecycle", () => {
  it("notifies subscribers until they unsubscribe", async () => {
    const store = new VaultStore();
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
    const store = new VaultStore();
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
    const store = new VaultStore();
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
    const reopened = new VaultStore();
    await expect(reopened.unlock(PASSWORD)).rejects.toBeInstanceOf(
      VaultCorruptError,
    );
  });

  it("rehydrates a header that appeared after construction", async () => {
    const store = new VaultStore();
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

  it("persists migrated prefs once for old installs", () => {
    kvSet(PREFS_KEY, JSON.stringify({ autoLockMinutes: 15, theme: "dark" }));
    const store = new VaultStore();
    expect(store.getSnapshot().prefs.autoLockMinutes).toBe(0);
    const stored = overlapCast(JSON.parse(kvGet(PREFS_KEY) ?? "{}"));
    expect(stored.prefsRevision).toBeGreaterThanOrEqual(2);
  });
});

describe("VaultStore TOTP challenge flow", () => {
  async function totpVault() {
    const { parseTotp, totpCode } = await import("./totp.js");
    const store = new VaultStore();
    await store.create(PASSWORD);
    const uri = await store.enrollTotp();
    const secret = new URL(uri).searchParams.get("secret");
    if (!secret) throw new Error("expected totp secret");
    store.lock();
    return { store, code: () => totpCode(parseTotp(secret)) };
  }

  it("rejects a wrong authenticator code and counts it", async () => {
    const { store } = await totpVault();
    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingTotp).toBe(true);

    await expect(reopened.confirmTotp("000000")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(kvGet(ATTEMPTS_KEY)).toContain('"fails":1');
    expect(store.isUnlocked()).toBe(false);
  });

  it("cancelling the challenge drops back to the password prompt", async () => {
    await totpVault();
    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingTotp).toBe(true);
    reopened.cancelTotpChallenge();
    expect(reopened.getSnapshot().awaitingTotp).toBe(false);
    expect(reopened.getSnapshot().status).toBe("locked");
  });

  it("demands a primary unlock before any code is checked", async () => {
    const store = await unlockedStore();
    store.lock();
    await expect(store.confirmTotp("123456")).rejects.toThrow(
      /primary unlock method first/,
    );
  });
});

describe("VaultStore unlock method management", () => {
  it("round-trips enrollPassword after the password was removed", async () => {
    const store = await unlockedStore();
    await store.enrollPin("48291037");
    await store.removePassword();
    expect(store.getSnapshot().header?.wrap).toBeUndefined();

    await store.enrollPassword(NEXT_PASSWORD);
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(NEXT_PASSWORD);
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });

  it("removes an enrolled PIN and no-ops when there is none", async () => {
    const store = await unlockedStore();
    await store.removePin(); // nothing enrolled: no throw, no change

    await store.enrollPin("48291037");
    expect(store.getSnapshot().header?.unlocks?.pin).toBeDefined();
    await store.removePin();
    expect(store.getSnapshot().header?.unlocks?.pin).toBeUndefined();
    store.lock();

    const reopened = new VaultStore();
    await expect(reopened.unlockWithPin("48291037")).rejects.toThrow(
      /did not unlock/,
    );
  });

  it("keeps the last primary unlock method when removing a PIN", async () => {
    const store = await unlockedStore();
    await store.enrollPin("48291037");
    await store.removePassword();
    await expect(store.removePin()).rejects.toThrow(/at least one primary/);
  });

  it("no-ops removing passkey or TOTP that were never enrolled", async () => {
    const store = await unlockedStore();
    await store.removePasskey();
    await store.removeTotp();
    expect(store.getSnapshot().header?.unlocks).toBeUndefined();
  });

  it("removes an enrolled TOTP gate", async () => {
    const store = await unlockedStore();
    await store.enrollTotp();
    expect(store.getSnapshot().header?.unlocks?.totp).toBeDefined();
    await store.removeTotp();
    expect(store.getSnapshot().header?.unlocks?.totp).toBeUndefined();
  });

  it("requires an unlocked vault to change unlock methods", async () => {
    const store = new VaultStore();
    await expect(store.enrollPin("48291037")).rejects.toThrow(/Unlock/);
    await expect(store.enrollPassword(NEXT_PASSWORD)).rejects.toThrow(/Unlock/);
    await expect(store.enrollTotp()).rejects.toThrow(/Unlock/);
  });
});

describe("VaultStore.changeMasterPassword", () => {
  it("re-keys the vault and retires the old password", async () => {
    const store = await unlockedStore();
    await store.changeMasterPassword(PASSWORD, NEXT_PASSWORD, "horses");
    store.lock();

    const reopened = new VaultStore();
    await expect(reopened.unlock(PASSWORD)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    await reopened.unlock(NEXT_PASSWORD);
    expect(reopened.getSnapshot().status).toBe("unlocked");
    expect(reopened.getSnapshot().header?.hint).toBe("horses");
  });

  it("rejects the wrong current password and a weak next one", async () => {
    const store = await unlockedStore();
    await expect(
      store.changeMasterPassword("wrong current password", NEXT_PASSWORD),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(
      store.changeMasterPassword(PASSWORD, "aaaaaaaaaaaa"),
    ).rejects.toThrow(/too easy to guess/);
  });

  it("has nothing to re-key on a device with no vault", async () => {
    const store = new VaultStore();
    await expect(
      store.changeMasterPassword(PASSWORD, NEXT_PASSWORD),
    ).rejects.toThrow(/no vault to re-key/);
  });

  it("has no master password to change once it was removed", async () => {
    const store = await unlockedStore();
    await store.enrollPin("48291037");
    await store.removePassword();
    await expect(
      store.changeMasterPassword(PASSWORD, NEXT_PASSWORD),
    ).rejects.toThrow(/no master password/);
  });
});

describe("VaultStore prefs and idle auto-lock", () => {
  it("persists prefs across instances", () => {
    const store = new VaultStore();
    store.setPrefs({ theme: "dark", lockOnHide: true });
    const reopened = new VaultStore();
    expect(reopened.getSnapshot().prefs.theme).toBe("dark");
    expect(reopened.getSnapshot().prefs.lockOnHide).toBe(true);
  });

  it("locks after the configured idle window", async () => {
    vi.useFakeTimers();
    try {
      const store = await unlockedStore();
      store.setPrefs({ autoLockMinutes: 1 });
      expect(store.isUnlocked()).toBe(true);

      vi.advanceTimersByTime(61_000);
      expect(store.isUnlocked()).toBe(false);
      expect(store.getSnapshot().status).toBe("locked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays unlocked while the operator keeps using the vault", async () => {
    vi.useFakeTimers();
    try {
      const store = await unlockedStore();
      store.setPrefs({ autoLockMinutes: 1 });

      vi.advanceTimersByTime(30_000);
      store.touch();
      vi.advanceTimersByTime(45_000);
      expect(store.isUnlocked()).toBe(true);

      vi.advanceTimersByTime(61_000);
      expect(store.isUnlocked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never arms a timer while the vault is locked", () => {
    vi.useFakeTimers();
    try {
      const store = new VaultStore();
      store.setPrefs({ autoLockMinutes: 1 });
      vi.advanceTimersByTime(120_000);
      expect(store.getSnapshot().status).toBe("empty");
    } finally {
      vi.useRealTimers();
    }
  });
});

import { overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvGet, kvSeams, kvSet } from "../kv.js";
import {
  PERSONAL_PROJECT_ID,
  PROJECTS_KEY,
  createProject,
  rehydrateProjects,
  setActiveProject,
} from "../projects.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { PBKDF2_ITERATIONS, createVault } from "./crypto.js";
import { createItem } from "./model.js";
import {
  ATTEMPTS_KEY,
  GUEST_TOMB,
  VaultCorruptError,
  VaultStore,
  WrongPasswordError,
  defaultPrefs,
  normalizeVaultPrefs,
} from "./store.js";
import { LEGACY_PREFS_KEY } from "./tomb-migration.js";

const PASSWORD = "correct horse battery staple";

/** The personal tomb's vault files — where header/body live now (ADR 0063). */
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);
const PREFS_KEY = LEGACY_PREFS_KEY;

/** Lets a test make the durable write fail the way a full disk would. */
const refuseWrites = vi.hoisted(() => ({ on: false }));

const originalKvSeams = { ...kvSeams };
Object.assign(kvSeams, {
  kvSetDurable: async (key: string, value: string) => {
    if (refuseWrites.on) throw new Error("storage refused the write");
    return originalKvSeams.kvSetDurable(key, value);
  },
});

/** Seed a real vault header, then hand back a store that reads it. */
async function storeWithVault(): Promise<VaultStore> {
  const { header } = await createVault(PASSWORD);
  kvSet(HEADER_KEY, JSON.stringify(header));
  return new VaultStore();
}

describe("VaultStore unlock lockout", () => {
  // The KV memory map is process-wide, so attempts must not leak between cases.
  beforeEach(() => {
    kvDelete(ATTEMPTS_KEY);
  });

  it("counts a wrong master password", async () => {
    const store = await storeWithVault();
    await expect(store.unlock("not the password")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(kvGet(ATTEMPTS_KEY)).toContain('"fails":1');
  });

  it("does not count a vault no password can open", async () => {
    const { header } = await createVault(PASSWORD);
    // An unsupported format fails for every password, so a lockout here would
    // punish the user for a broken file.
    kvSet(HEADER_KEY, JSON.stringify({ ...header, v: 2 }));
    const store = new VaultStore();

    await expect(store.unlock(PASSWORD)).rejects.toBeInstanceOf(
      VaultCorruptError,
    );
    expect(kvGet(ATTEMPTS_KEY)).toBeNull();
  });

  // The wrap is made under these parameters, so altered ones cannot open it
  // anyway. Saying the file was tampered with beats blaming the password.
  it("refuses a header whose derivation parameters were altered", async () => {
    const { header } = await createVault(PASSWORD);
    kvSet(
      HEADER_KEY,
      JSON.stringify({
        ...header,
        kdf: { ...header.kdf, iterations: Math.floor(PBKDF2_ITERATIONS / 600) },
      }),
    );
    const store = new VaultStore();

    await expect(store.unlock(PASSWORD)).rejects.toBeInstanceOf(
      VaultCorruptError,
    );
    expect(kvGet(ATTEMPTS_KEY)).toBeNull();
  });
});

describe("VaultStore rollback detection", () => {
  beforeEach(async () => {
    await vfsFlush();
    kvDelete(ATTEMPTS_KEY);
    kvDelete(HEADER_KEY);
    kvDelete(BODY_KEY);
    kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  });

  // A restored backup or a synced-over write puts back a body the vault has moved
  // past. Opening it silently would return deleted items and stale passwords.
  it("refuses a body older than the last write recorded here", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.saveItem(createItem("login", "First"));
    const snapshot = kvGet(BODY_KEY);

    await store.saveItem(createItem("login", "Second"));
    store.lock();

    // Put the older file back, exactly as a restore would.
    kvSet(BODY_KEY, overlapCast(snapshot));
    const reopened = new VaultStore();
    await expect(reopened.unlock(PASSWORD)).rejects.toThrow(/older/u);
  }, 15_000);

  // A write that fails must not count. If it did, the body would sit one behind
  // the header and the vault would refuse to open next time.
  it("survives a failed write without looking rolled back", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.saveItem(createItem("login", "Kept"));

    refuseWrites.on = true;
    await expect(store.saveItem(createItem("login", "Lost"))).rejects.toThrow(
      /storage refused/u,
    );
    refuseWrites.on = false;

    // The mutation that failed is gone from memory, and what remains still opens.
    await store.saveItem(createItem("login", "After"));
    store.lock();
    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().items.map((item) => item.name)).toEqual([
      "Kept",
      "After",
    ]);
  });

  // Deleting has to outlast a write already in the air, or the vault comes back
  // on a device it was deleted from.
  it("stays deleted when a write was already in flight", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);

    // Started, not awaited: its seal-and-write is still to come.
    const saving = store.saveItem(createItem("login", "Racing"));
    await store.destroy();
    await saving.catch(() => undefined);

    expect(kvGet(HEADER_KEY)).toBeNull();
    expect(kvGet(BODY_KEY)).toBeNull();
    expect(new VaultStore().getSnapshot().status).toBe("empty");
  });

  it("opens the body it last wrote", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.saveItem(createItem("login", "Kept"));
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().items.map((item) => item.name)).toEqual([
      "Kept",
    ]);
  });
});

describe("VaultStore multi-method unlock", () => {
  beforeEach(async () => {
    await vfsFlush();
    kvDelete(ATTEMPTS_KEY);
    kvDelete(HEADER_KEY);
    kvDelete(BODY_KEY);
    kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  });

  it("seals a new vault with a PIN and no master password", async () => {
    const store = new VaultStore();
    await store.createWithPin("48291037");
    const header = store.getSnapshot().header;
    expect(header?.unlocks?.pin).toBeDefined();
    expect(header?.wrap).toBeUndefined();
    expect(header?.kdf).toBeUndefined();
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlockWithPin("48291037");
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });

  it("carries an unlocked vault into a new project without asking for a password", async () => {
    kvDelete(PROJECTS_KEY);
    rehydrateProjects();
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.saveItem(createItem("login", "Personal only"));
    const project = await createProject("Work");
    await setActiveProject(project.id);
    await store.forkUnlockedIntoActiveScope();
    expect(store.getSnapshot().status).toBe("unlocked");
    expect(store.getSnapshot().items).toEqual([]);
    expect(store.getSnapshot().header?.wrap).toBeDefined();
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().status).toBe("unlocked");
    expect(reopened.getSnapshot().items).toEqual([]);

    await setActiveProject(PERSONAL_PROJECT_ID);
    kvDelete(PROJECTS_KEY);
    rehydrateProjects();
  });

  it("refuses to fork a locked vault into a new project", async () => {
    const store = new VaultStore();
    await expect(store.forkUnlockedIntoActiveScope()).rejects.toThrow(
      /Unlock the vault/,
    );
  });

  it("loads the active project scope and drops the previous vault key", async () => {
    kvDelete(PROJECTS_KEY);
    rehydrateProjects();
    const store = new VaultStore();
    await store.create(PASSWORD);
    const project = await createProject("Work");
    await setActiveProject(project.id);
    store.loadActiveProjectScope();
    expect(store.isUnlocked()).toBe(false);
    expect(store.getSnapshot().status).toBe("empty");
    await setActiveProject(PERSONAL_PROJECT_ID);
    kvDelete(PROJECTS_KEY);
    rehydrateProjects();
  });

  it("lets a guest in without wrapping a password or passkey", async () => {
    kvDelete(HEADER_KEY);
    const store = new VaultStore();
    await store.createGuest();
    expect(store.getSnapshot().status).toBe("unlocked");
    expect(store.getSnapshot().header?.wrap).toBeUndefined();
    expect(kvGet(HEADER_KEY)).toBeNull();
    store.lock();
    expect(store.getSnapshot().status).toBe("empty");
  });

  it("runs a guest beside a sealed vault in its own tomb and hands the vault back on lock", async () => {
    const store = await storeWithVault();
    const sealedHeader = kvGet(HEADER_KEY);
    expect(store.getSnapshot().status).toBe("locked");

    await store.createGuest();
    expect(store.getSnapshot().status).toBe("unlocked");
    expect(store.getSnapshot().header?.wrap).toBeUndefined();
    // A guest write lands in the guest tomb, never on the sealed vault.
    await store.saveItem(createItem("note", "guest note"));
    expect(kvGet(HEADER_KEY)).toBe(sealedHeader);
    expect(kvGet(BODY_KEY)).toBeNull();
    expect(kvGet(tombFileKey(GUEST_TOMB, BODY_PATH))).not.toBeNull();

    store.lock();
    // Not "empty": the real vault is back, exactly as it was.
    expect(store.getSnapshot().status).toBe("locked");
    expect(store.getSnapshot().header?.wrap).toBeDefined();
    await store.unlock(PASSWORD);
    expect(store.getSnapshot().items).toHaveLength(0);
  });

  it("lets a guest beside a sealed vault delete only the guest tomb", async () => {
    const store = await storeWithVault();
    await store.createGuest();
    await store.saveItem(createItem("note", "guest note"));
    await store.destroy();
    expect(kvGet(HEADER_KEY)).not.toBeNull();
    expect(kvGet(tombFileKey(GUEST_TOMB, BODY_PATH))).toBeNull();
    expect(store.getSnapshot().status).toBe("locked");
  });

  it("rejects a weak PIN without creating a vault", async () => {
    const store = new VaultStore();
    await expect(store.createWithPin("11111111")).rejects.toThrow(/repeated/);
    expect(store.getSnapshot().status).toBe("empty");
  });

  it("unlocks with an enrolled PIN after locking", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.enrollPin("48291037");
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlockWithPin("48291037");
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });

  it("requires TOTP after primary unlock when MFA is enrolled", async () => {
    const { totpCode, parseTotp } = await import("./totp.js");
    const store = new VaultStore();
    await store.create(PASSWORD);
    const uri = await store.enrollTotp();
    const secret = new URL(uri).searchParams.get("secret");
    expect(secret).toBeTruthy();
    if (!secret) throw new Error("expected totp secret in otpauth URI");
    store.lock();

    const reopened = new VaultStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingTotp).toBe(true);
    expect(reopened.getSnapshot().status).toBe("locked");

    const code = await totpCode(parseTotp(secret));
    await reopened.confirmTotp(code);
    expect(reopened.getSnapshot().status).toBe("unlocked");
    expect(reopened.getSnapshot().awaitingTotp).toBe(false);
  });

  it("keeps at least one primary unlock method", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await expect(store.removePassword()).rejects.toThrow(
      /at least one primary/,
    );
  });

  it("can drop the password after a PIN is enrolled", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.enrollPin("48291037");
    await store.removePassword();
    expect(store.getSnapshot().header?.wrap).toBeUndefined();
    store.lock();

    const reopened = new VaultStore();
    // A challenge the vault no longer enrolls fails like a wrong secret —
    // same generic error, same lockout count.
    await expect(reopened.unlock(PASSWORD)).rejects.toThrow(/did not unlock/);
    await reopened.unlockWithPin("48291037");
    expect(reopened.getSnapshot().status).toBe("unlocked");
  });

  it("rejects sealed imports that have no password wrap", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await store.enrollPin("48291037");
    await store.removePassword();
    const sealed = store.exportSealed();
    await expect(store.importSealed(sealed, PASSWORD)).rejects.toThrow(
      /no master-password unlock/,
    );
  });
});

describe("vault prefs locking defaults", () => {
  beforeEach(() => {
    kvDelete(PREFS_KEY);
  });

  it("defaults auto-lock to off and does not sign out on lock", () => {
    expect(defaultPrefs.autoLockMinutes).toBe(0);
    expect(defaultPrefs.signOutOnLock).toBe(false);
    expect(defaultPrefs.lockOnHide).toBe(false);
  });

  it("migrates the old 15-minute default to Never once", () => {
    const migrated = normalizeVaultPrefs({
      autoLockMinutes: 15,
      lockOnHide: false,
      clipboardClearSeconds: 30,
      theme: "system",
    });
    expect(migrated.autoLockMinutes).toBe(0);
    expect(migrated.signOutOnLock).toBe(false);
    expect(migrated.prefsRevision).toBeGreaterThanOrEqual(2);
  });

  it("keeps an explicit 15-minute choice after the prefs revision is current", () => {
    const kept = normalizeVaultPrefs({
      autoLockMinutes: 15,
      lockOnHide: false,
      clipboardClearSeconds: 30,
      theme: "dark",
      prefsRevision: 2,
      signOutOnLock: true,
    });
    expect(kept.autoLockMinutes).toBe(15);
    expect(kept.signOutOnLock).toBe(true);
    expect(kept.theme).toBe("dark");
  });
});

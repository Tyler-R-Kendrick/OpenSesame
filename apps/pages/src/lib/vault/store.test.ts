import { beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvGet, kvSeams, kvSet } from "../kv.js";
import { PBKDF2_ITERATIONS, createVault } from "./crypto.js";
import { createItem } from "./model.js";
import {
  ATTEMPTS_KEY,
  BODY_KEY,
  HEADER_KEY,
  PREFS_KEY,
  VaultCorruptError,
  VaultStore,
  WrongPasswordError,
  defaultPrefs,
  normalizeVaultPrefs,
} from "./store.js";
import { overlapCast } from "@opensesame/os-domain";

const PASSWORD = "correct horse battery staple";

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
  beforeEach(() => {
    kvDelete(ATTEMPTS_KEY);
    kvDelete(HEADER_KEY);
    kvDelete(BODY_KEY);
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
  beforeEach(() => {
    kvDelete(ATTEMPTS_KEY);
    kvDelete(HEADER_KEY);
    kvDelete(BODY_KEY);
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
    await expect(reopened.unlock(PASSWORD)).rejects.toBeInstanceOf(
      VaultCorruptError,
    );
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

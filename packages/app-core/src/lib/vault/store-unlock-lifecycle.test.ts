import { parseTotp, totpCode } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import { kvGet } from "../kv.js";
import * as trustedUnlock from "../trusted-unlock.js";
import { vfsFlush } from "../vfs.js";
import {
  NEXT_PASSWORD,
  PASSWORD,
  installStoreOperationsFixture,
  newStore,
  unlockedStore,
} from "./store-ops.fixture.js";
import { enrollTotp } from "./store-totp.fixture.js";
import { ATTEMPTS_KEY, WrongPasswordError } from "./store.js";
import * as unlockMethods from "./unlock-methods.js";

installStoreOperationsFixture();

describe("VaultStore TOTP challenge flow", () => {
  async function totpVault() {
    const store = newStore();
    await store.create(PASSWORD);
    const uri = await enrollTotp(store);
    const secret = new URL(uri).searchParams.get("secret");
    if (!secret) throw new Error("expected totp secret");
    // Withdraw the vault's own authenticator (ADR 0113) so the code is asked.
    const selfId = store.getSnapshot().header?.unlocks?.totp?.selfItemId ?? "";
    await store.trashItem(selfId);
    store.lock();
    return { store, code: () => totpCode(parseTotp(secret)) };
  }

  it("rejects a wrong authenticator code and counts it", async () => {
    const { store } = await totpVault();
    const reopened = newStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(true);

    await expect(reopened.confirmTotp("000000")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(kvGet(ATTEMPTS_KEY)).toContain('"fails":1');
    expect(store.isUnlocked()).toBe(false);
  });

  it("cancelling the challenge drops back to the password prompt", async () => {
    await totpVault();
    const reopened = newStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(true);
    reopened.cancelTotpChallenge();
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(false);
    expect(reopened.getSnapshot().status).toBe("locked");
  });

  it("rejects confirmTotp after cancel even when verification was in flight", async () => {
    const { code } = await totpVault();
    const reopened = newStore();
    await reopened.unlock(PASSWORD);
    let releaseVerification: () => void = () => {};
    let markVerificationStarted: () => void = () => {};
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    const verificationParked = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const matchSpy = vi
      .spyOn(unlockMethods, "totpCodeMatches")
      .mockImplementation(async () => {
        markVerificationStarted();
        await verificationParked;
        return true;
      });
    try {
      const confirm = reopened.confirmTotp(await code());
      await verificationStarted;
      reopened.cancelTotpChallenge();
      releaseVerification();
      await expect(confirm).rejects.toThrow(/no longer pending/);
      expect(reopened.isUnlocked()).toBe(false);
      expect(reopened.getSnapshot().status).toBe("locked");
      expect(reopened.getSnapshot().awaitingSecondStep).toBe(false);
    } finally {
      matchSpy.mockRestore();
    }
  });

  it("does not activate when cancelTotpChallenge lands during second-step completion", async () => {
    const { code } = await totpVault();
    const reopened = newStore();
    await reopened.unlock(PASSWORD);
    const read = vi
      .spyOn(trustedUnlock, "readTrustedUnlock")
      .mockImplementation(async () => {
        reopened.cancelTotpChallenge();
        return null;
      });
    try {
      await expect(reopened.confirmTotp(await code())).rejects.toThrow(
        /no longer pending/,
      );
      expect(reopened.isUnlocked()).toBe(false);
      expect(reopened.getSnapshot().status).toBe("locked");
    } finally {
      read.mockRestore();
    }
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

    const reopened = newStore();
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

    const reopened = newStore();
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
    await enrollTotp(store);
    expect(store.getSnapshot().header?.unlocks?.totp).toBeDefined();
    await store.removeTotp();
    expect(store.getSnapshot().header?.unlocks?.totp).toBeUndefined();
  });

  it("requires an unlocked vault to change unlock methods", async () => {
    const store = newStore();
    await expect(store.enrollPin("48291037")).rejects.toThrow(/Unlock/);
    await expect(store.enrollPassword(NEXT_PASSWORD)).rejects.toThrow(/Unlock/);
    await expect(store.beginTotpEnrollment()).rejects.toThrow(/Unlock/);
  });
});

describe("VaultStore.changeMasterPassword", () => {
  it("re-keys the vault and retires the old password", async () => {
    const store = await unlockedStore();
    await store.changeMasterPassword(PASSWORD, NEXT_PASSWORD, "horses");
    store.lock();

    const reopened = newStore();
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
    const store = newStore();
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
  it("persists prefs across instances — readable again once unlocked", async () => {
    const store = newStore();
    await store.create(PASSWORD);
    store.setPrefs({ theme: "dark", lockOnHide: true });
    // setPrefs persists on the write chain; a reload boundary is where the write must have landed.
    await vfsFlush();
    store.lock();

    // Prefs live in the sealed tomb config now: a locked store cannot read
    // them, so defaults stand until unlock.
    const locked = newStore();
    expect(locked.getSnapshot().prefs.theme).toBe("system");
    await locked.unlock(PASSWORD);
    expect(locked.getSnapshot().prefs.theme).toBe("dark");
    expect(locked.getSnapshot().prefs.lockOnHide).toBe(true);
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
      const store = newStore();
      store.setPrefs({ autoLockMinutes: 1 });
      vi.advanceTimersByTime(120_000);
      expect(store.getSnapshot().status).toBe("empty");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("VaultStore authenticator enrollment", () => {
  it("writes the gate only once a code from the app matches", async () => {
    const store = await unlockedStore();
    const uri = await store.beginTotpEnrollment();
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    // Nothing on disk yet: the seed is an offer until a code proves the scan.
    expect(store.getSnapshot().header?.unlocks?.totp).toBeUndefined();
    await expect(store.confirmTotpEnrollment("000000")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(store.getSnapshot().header?.unlocks?.totp).toBeUndefined();
    // A wrong code during enrollment is not a failed unlock.
    expect(store.getSnapshot().failedAttempts).toBe(0);
    const secret = new URL(uri).searchParams.get("secret") ?? "";
    await store.confirmTotpEnrollment(await totpCode(parseTotp(secret)));
    expect(store.getSnapshot().header?.unlocks?.totp).toBeDefined();
  });

  it("refuses to confirm with no enrollment in progress, and forgets a cancelled one", async () => {
    const store = await unlockedStore();
    await expect(store.confirmTotpEnrollment("123456")).rejects.toThrow(
      /Start authenticator enrollment/,
    );
    await store.beginTotpEnrollment();
    store.cancelTotpEnrollment();
    await expect(store.confirmTotpEnrollment("123456")).rejects.toThrow(
      /Start authenticator enrollment/,
    );
  });

  it("refuses a guest session: a code can only guard a key", async () => {
    const store = newStore();
    await store.createGuest();
    await expect(store.beginTotpEnrollment()).rejects.toThrow(
      /passkey, PIN or password/,
    );
    // The bug this closes: a guest that enrolled MFA wrote a header with a
    // gate and no wrap — a vault nothing could ever open.
    expect(store.getSnapshot().header?.unlocks?.totp).toBeUndefined();
  });
});

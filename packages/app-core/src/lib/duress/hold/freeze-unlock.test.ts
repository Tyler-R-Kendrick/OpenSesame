/**
 * The freeze mode, end to end with real crypto through the real unlock path:
 * arm it, type the code where a password is typed, and the vault's own
 * password is then refused as a wrong one is, until the clock passes the hold.
 */

import { WrongPasswordError, createVault } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unlockWithPasswordAfterDuressGate } from "../../../screens/unlock/unlock-password-duress.js";
import { kvDelete, kvSet } from "../../kv.js";
import { LAST_VAULT_KEY } from "../../last-vault.js";
import { ATTEMPTS_KEY, VaultStore } from "../../vault/store.js";
import { HEADER_PATH, PERSONAL_TOMB, tombFileKey } from "../../vfs.js";
import { duressSessionFence } from "../session/fence.js";
import {
  enableDuressCode,
  removeDuressCode,
} from "../settings/device-duress.js";
import { HOLD_KEY } from "../store/boot-keys.js";
import { clearJournal } from "../store/journal.js";
import { HOUR_MS, readHold } from "./record.js";

const PASSWORD = "correct horse battery staple";
const CODE = "246813579";
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const gate = { requireDurable: false };

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
}

async function lockedStore(): Promise<VaultStore> {
  const { header } = await createVault(PASSWORD);
  kvSet(HEADER_KEY, JSON.stringify(header));
  const store = new VaultStore();
  store.rehydrate();
  return store;
}

async function armed(mode: string, extras: Record<string, string>) {
  const result = await enableDuressCode({
    code: CODE,
    mode,
    extras,
    vaultRef: "vault-freeze",
    requireDurable: false,
  });
  expect(result).toEqual({ ok: true });
}

/** What the unlock screen would show for this attempt, or null if it opened. */
async function shown(
  store: VaultStore,
  secret: string,
): Promise<string | null> {
  try {
    await unlockWithPasswordAfterDuressGate(store, secret, gate);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(WrongPasswordError);
    return (error as Error).message;
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  clearJournal(HOLD_KEY);
  kvDelete(HEADER_KEY);
  kvDelete(ATTEMPTS_KEY);
  kvDelete(LAST_VAULT_KEY);
  resetFence();
});

afterEach(async () => {
  await removeDuressCode();
  resetFence();
  vi.useRealTimers();
});

describe("freeze mode through the unlock path", () => {
  it("refuses the real password after the code, then accepts it past the hold", async () => {
    const store = await lockedStore();
    await armed("freeze", { freeze_hours: "24" });

    const ordinary = await shown(store, "an ordinary wrong password");
    expect(ordinary).not.toBeNull();
    expect(readHold()).toBeNull();

    // The code reads as a wrong password and leaves the hold behind.
    expect(await shown(store, CODE)).toBe(ordinary);
    expect(readHold()).toEqual({ until: T0 + 24 * HOUR_MS, setAt: T0 });
    expect(store.getSnapshot().status).toBe("locked");

    // The vault's own password is now refused the same way.
    expect(await shown(store, PASSWORD)).toBe(ordinary);
    expect(store.getSnapshot().status).toBe("locked");
    vi.setSystemTime(T0 + 24 * HOUR_MS - 1);
    expect(await shown(store, PASSWORD)).toBe(ordinary);

    vi.setSystemTime(T0 + 24 * HOUR_MS);
    expect(await shown(store, PASSWORD)).toBeNull();
    expect(store.getSnapshot().status).toBe("unlocked");
  });

  it("is extend-only when the code is typed again", async () => {
    const store = await lockedStore();
    await armed("freeze", { freeze_hours: "72" });
    await shown(store, CODE);
    const until = readHold()?.until;
    expect(until).toBe(T0 + 72 * HOUR_MS);

    // The owner, once cleared, sets a shorter freeze; the hold stands.
    resetFence();
    await armed("freeze", { freeze_hours: "1" });
    vi.setSystemTime(T0 + HOUR_MS);
    await shown(store, CODE);
    expect(readHold()?.until).toBe(until);
  });

  it("does nothing under a mode with no plan: the real password still opens", async () => {
    // The negative control: it is the hold, not the refusal, that stops the
    // real password, so a build that records nothing fails the test above.
    const store = await lockedStore();
    await armed("refuse", {});
    expect(await shown(store, CODE)).not.toBeNull();
    expect(readHold()).toBeNull();
    expect(await shown(store, PASSWORD)).toBeNull();
    expect(store.getSnapshot().status).toBe("unlocked");
  });
});

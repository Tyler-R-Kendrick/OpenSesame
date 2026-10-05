/**
 * A refusal while the device is held must leave nothing of the real vault key
 * in memory: the bytes a credential unwrapped are zeroed, no session key is
 * set and no second step is parked.
 */

import { createVault } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvSet } from "../../kv.js";
import { LAST_VAULT_KEY } from "../../last-vault.js";
import { unwrapSeams } from "../../vault/primary-unwrap.js";
import { ATTEMPTS_KEY, VaultStore } from "../../vault/store.js";
import { HEADER_PATH, PERSONAL_TOMB, tombFileKey } from "../../vfs.js";
import { HOLD_KEY } from "../store/boot-keys.js";
import { clearJournal } from "../store/journal.js";
import { HOUR_MS, extendHold } from "./record.js";

// Every raw key a credential unwrapped, seen through the store's own seam: the
// real unwrapping still runs, and the bytes it hands back are kept to be read.
const opened: Uint8Array[] = [];
const real = { ...unwrapSeams };

const PASSWORD = "correct horse battery staple";
const PIN = "48291037";
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);

async function lockedStoreWithPin(): Promise<VaultStore> {
  const { header } = await createVault(PASSWORD);
  kvSet(HEADER_KEY, JSON.stringify(header));
  const store = new VaultStore();
  store.rehydrate();
  await store.unlock(PASSWORD);
  await store.enrollPin(PIN);
  store.lock();
  return store;
}

function expectReleased(store: VaultStore): void {
  expect(opened.length).toBeGreaterThan(0);
  for (const raw of opened) {
    expect(raw.length).toBeGreaterThan(0);
    expect([...raw].every((byte) => byte === 0)).toBe(true);
  }
  const snap = store.getSnapshot();
  expect(snap.status).toBe("locked");
  expect(snap.awaitingSecondStep).toBe(false);
  expect(() => store.pendingSecondStepCode()).not.toThrow();
  expect(store.pendingSecondStepCode()).toBeNull();
  // No raw key to enrol anything with: the store holds no session at all.
  expect(() => store.exportSealed()).toThrow();
}

beforeEach(() => {
  unwrapSeams.password = async (...args) => {
    const raw = await real.password(...args);
    opened.push(raw);
    return raw;
  };
  unwrapSeams.pin = async (...args) => {
    const raw = await real.pin(...args);
    opened.push(raw);
    return raw;
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 9, 5, 12, 0, 0));
  clearJournal(HOLD_KEY);
  kvDelete(ATTEMPTS_KEY);
  kvDelete(LAST_VAULT_KEY);
  opened.length = 0;
});

afterEach(() => {
  Object.assign(unwrapSeams, real);
  vi.useRealTimers();
  clearJournal(HOLD_KEY);
});

describe("a frozen refusal releases what the credential opened", () => {
  it("zeroes the raw key a right password unwrapped", async () => {
    const store = await lockedStoreWithPin();
    opened.length = 0;
    await extendHold(1);
    await expect(store.unlock(PASSWORD)).rejects.toThrow();
    expectReleased(store);
  });

  it("zeroes the raw key a right PIN unwrapped", async () => {
    const store = await lockedStoreWithPin();
    opened.length = 0;
    await extendHold(1);
    await expect(store.unlockWithPin(PIN)).rejects.toThrow();
    expectReleased(store);
  });

  it("keeps the key once the hold has passed, so the test sees the difference", async () => {
    const store = await lockedStoreWithPin();
    opened.length = 0;
    await extendHold(1);
    vi.setSystemTime(Date.now() + HOUR_MS);
    await store.unlock(PASSWORD);
    expect(store.getSnapshot().status).toBe("unlocked");
    expect(opened.some((raw) => raw.some((byte) => byte !== 0))).toBe(true);
  });
});

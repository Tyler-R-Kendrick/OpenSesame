import { WrongPasswordError, createVault } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvSet } from "../../kv.js";
import { LAST_VAULT_KEY } from "../../last-vault.js";
import { ATTEMPTS_KEY, VaultStore } from "../../vault/store.js";
import {
  GUEST_TOMB,
  HEADER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
} from "../../vfs.js";
import { rejectionOf } from "../rejection.test-support.js";
import { HOLD_KEY } from "../store/boot-keys.js";
import { clearJournal, journalSeams, writeJournal } from "../store/journal.js";
import { isFrozen } from "./gate.js";
import { HOUR_MS, extendHold, readHold } from "./record.js";

const PASSWORD = "correct horse battery staple";
const PIN = "48291037";
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);

async function lockedStore(): Promise<VaultStore> {
  const { header } = await createVault(PASSWORD);
  kvSet(HEADER_KEY, JSON.stringify(header));
  const store = new VaultStore();
  store.rehydrate();
  return store;
}

async function messageOf<T>(attempt: Promise<T>): Promise<string> {
  const error = await rejectionOf(attempt);
  expect(error).toBeInstanceOf(WrongPasswordError);
  return error.message;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  clearJournal(HOLD_KEY);
  kvDelete(HEADER_KEY);
  kvDelete(tombFileKey(GUEST_TOMB, HEADER_PATH));
  kvDelete(ATTEMPTS_KEY);
  kvDelete(LAST_VAULT_KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the hold record", () => {
  it("records until and setAt from the chosen hours", async () => {
    expect(await extendHold(24)).toBe(true);
    expect(readHold()).toEqual({ until: T0 + 24 * HOUR_MS, setAt: T0 });
  });

  it("only ever extends: a shorter or equal freeze leaves the longer hold", async () => {
    await extendHold(24);
    expect(await extendHold(1)).toBe(false);
    expect(await extendHold(24)).toBe(false);
    expect(readHold()).toEqual({ until: T0 + 24 * HOUR_MS, setAt: T0 });
    vi.setSystemTime(T0 + HOUR_MS);
    expect(await extendHold(1)).toBe(false);
    expect(readHold()?.until).toBe(T0 + 24 * HOUR_MS);
    expect(await extendHold(72)).toBe(true);
    expect(readHold()?.until).toBe(T0 + HOUR_MS + 72 * HOUR_MS);
  });

  it("is replaced by a new freeze once it has expired", async () => {
    await extendHold(1);
    vi.setSystemTime(T0 + 2 * HOUR_MS);
    expect(await extendHold(1)).toBe(true);
    expect(readHold()?.until).toBe(T0 + 3 * HOUR_MS);
  });

  it("records nothing for hours that were not offered", async () => {
    for (const hours of [0, 2, 12, 73, -24, Number.NaN, "24", null]) {
      expect(await extendHold(hours)).toBe(false);
    }
    expect(readHold()).toBeNull();
  });

  it("records nothing, and does not throw, when storage refuses the write", async () => {
    vi.spyOn(journalSeams, "durability").mockReturnValue("persistent");
    vi.spyOn(journalSeams, "setDurable").mockRejectedValue(
      new Error("storage refused the write"),
    );
    await expect(extendHold(24)).resolves.toBe(false);
    expect(readHold()).toBeNull();
    expect(isFrozen()).toBe(false);
  });
});

describe("what counts as a hold", () => {
  it("is not frozen with no record, and is once a record stands", async () => {
    expect(isFrozen()).toBe(false);
    await extendHold(1);
    expect(isFrozen()).toBe(true);
    vi.setSystemTime(T0 + HOUR_MS - 1);
    expect(isFrozen()).toBe(true);
    vi.setSystemTime(T0 + HOUR_MS);
    expect(isFrozen()).toBe(false);
  });

  it("fails open on a record that is garbled, unversioned or asks for too much", async () => {
    const garbled: string[] = [
      "{not json",
      JSON.stringify({ schemaVersion: 2, revision: 1, payload: {} }),
      JSON.stringify({ schemaVersion: 1, revision: 1 }),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        payload: { until: "later", setAt: T0 },
      }),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        payload: { until: T0 - 1, setAt: T0 },
      }),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        payload: { until: T0 + 73 * HOUR_MS, setAt: T0 },
      }),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        payload: { until: 1e300, setAt: T0 },
      }),
    ];
    for (const raw of garbled) {
      kvSet(HOLD_KEY, raw);
      expect(readHold()).toBeNull();
      expect(isFrozen()).toBe(false);
    }
  });

  it("holds a little longer when the clock is set back, and lets go when it is set far back", async () => {
    await extendHold(24);
    vi.setSystemTime(T0 - HOUR_MS);
    expect(isFrozen()).toBe(true);
    vi.setSystemTime(T0 - 100 * HOUR_MS);
    expect(isFrozen()).toBe(false);
  });
});

describe("the vault store while the device is held", () => {
  it("refuses the real password exactly as a wrong one is, and counts it", async () => {
    const store = await lockedStore();
    const wrong = await messageOf(store.unlock("not the password"));
    expect(store.getSnapshot().failedAttempts).toBe(1);

    await extendHold(24);
    const refused = await messageOf(store.unlock(PASSWORD));
    expect(refused).toBe(wrong);
    const snap = store.getSnapshot();
    expect(snap.status).toBe("locked");
    expect(snap.failedAttempts).toBe(2);
  });

  it("refuses the real PIN with the text a wrong PIN gets", async () => {
    const store = await lockedStore();
    await store.unlock(PASSWORD);
    await store.enrollPin(PIN);
    store.lock();
    const wrong = await messageOf(store.unlockWithPin("13572468"));

    await extendHold(1);
    expect(await messageOf(store.unlockWithPin(PIN))).toBe(wrong);
    expect(store.getSnapshot().status).toBe("locked");
  });

  it("opens with the real password once the hold has passed", async () => {
    const store = await lockedStore();
    await extendHold(24);
    await messageOf(store.unlock(PASSWORD));
    vi.setSystemTime(T0 + 24 * HOUR_MS - 1);
    await messageOf(store.unlock(PASSWORD));
    vi.setSystemTime(T0 + 24 * HOUR_MS);
    await store.unlock(PASSWORD);
    expect(store.getSnapshot().status).toBe("unlocked");
  });

  it("never holds the guest tomb, whose access is not removed", async () => {
    const store = await lockedStore();
    await store.createGuest();
    await store.enrollPin(PIN);
    store.lock();
    store.rehydrate();
    expect(store.getSnapshot().tomb).toBe(GUEST_TOMB);

    await extendHold(72);
    await store.unlockWithPin(PIN);
    expect(store.getSnapshot().status).toBe("unlocked");
    expect(store.getSnapshot().tomb).toBe(GUEST_TOMB);
    store.lock();
    await store.createGuest();
    expect(store.getSnapshot().status).toBe("unlocked");
  });

  it("opens the real vault when the record is garbled", async () => {
    const store = await lockedStore();
    kvSet(HOLD_KEY, "{not json");
    await store.unlock(PASSWORD);
    expect(store.getSnapshot().status).toBe("unlocked");
  });

  it("is read from the journal alone, so a record written through it holds", async () => {
    const store = await lockedStore();
    await writeJournal(HOLD_KEY, { until: T0 + HOUR_MS, setAt: T0 });
    await messageOf(store.unlock(PASSWORD));
  });
});

/**
 * A key's date and a vault that unlocks again and again (ADR 0160 §5a). The
 * tomb's file is this device's own and is read with no upper bound on its date,
 * so what goes into the body is brought inside the window the body's readers
 * accept (never later than now, never long before the vault existed), and an
 * unlock that finds the body already carrying the key writes nothing.
 */

/** @vitest-environment jsdom */
import {
  DEVICE_KEY_CLOCK_MARGIN_MS,
  deviceKeyTimeBounds,
  readDeviceIdentityKeyRecord,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { genuineRecord } from "../__tests__/device-identity-records.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import {
  forgetDeviceIdentityKeyInFlightForTests,
  writeStoredDeviceIdentityKey,
} from "../device-identity-key.js";
import { kvDelete } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { bodyPortOf } from "./store-device-key.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";
const DAY = DEVICE_KEY_CLOCK_MARGIN_MS;

function wipe(): void {
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
    "config/device-identity-key",
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  kvDelete(ATTEMPTS_KEY);
  forgetDeviceIdentityKeyInFlightForTests();
}

beforeEach(async () => {
  await vfsFlush();
  wipe();
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
});

afterEach(async () => {
  await vfsFlush();
  vi.unstubAllGlobals();
});

/** A vault whose tomb holds a key dated `createdAt`, locked and ready to unlock. */
async function vaultWithTombKeyDated(createdAt: number) {
  const store = new VaultStore();
  await store.create(PASSWORD);
  const record = { ...(await genuineRecord(Date.now())), createdAt };
  await writeStoredDeviceIdentityKey(PERSONAL_TOMB, record);
  await store.flushPendingWrites();
  await vfsFlush();
  store.lock();
  return { store, record };
}

async function unlockAndSettle(store: VaultStore) {
  await store.unlock(PASSWORD);
  await store.flushPendingWrites();
  await vfsFlush();
  const port = bodyPortOf(store);
  return { rev: port.body().rev, field: port.body().deviceIdentityKey };
}

describe("a tomb key dated outside the window", () => {
  it("is published with a date the body's readers accept, and later unlocks write nothing", async () => {
    const { store, record } = await vaultWithTombKeyDated(Date.now() + 3 * DAY);
    const first = await unlockAndSettle(store);
    const carried = readDeviceIdentityKeyRecord(first.field);
    expect(carried?.keyId).toBe(record.keyId);
    expect(carried?.createdAt).toBeLessThanOrEqual(Date.now());

    store.lock();
    const second = await unlockAndSettle(store);
    store.lock();
    const third = await unlockAndSettle(store);
    expect(second.rev).toBe(first.rev);
    expect(third.rev).toBe(first.rev);
    expect(third.field).toEqual(first.field);
  });

  it("is published no earlier than the window opens when it is dated before the vault", async () => {
    const { store, record } = await vaultWithTombKeyDated(5);
    const first = await unlockAndSettle(store);
    const { notBefore } = deviceKeyTimeBounds(
      bodyPortOf(store).header()?.createdAt,
    );
    const carried = readDeviceIdentityKeyRecord(
      first.field,
      Date.now(),
      notBefore,
    );
    expect(carried?.keyId).toBe(record.keyId);
    expect(carried?.createdAt).toBeGreaterThanOrEqual(notBefore);

    store.lock();
    const second = await unlockAndSettle(store);
    expect(second.rev).toBe(first.rev);
  });
});

describe("a tomb key in order", () => {
  it("is published once, and a second and third unlock write nothing", async () => {
    const { store } = await vaultWithTombKeyDated(Date.now() - 1000);
    const first = await unlockAndSettle(store);
    store.lock();
    const second = await unlockAndSettle(store);
    store.lock();
    const third = await unlockAndSettle(store);
    expect(second.rev).toBe(first.rev);
    expect(third.rev).toBe(first.rev);
  });
});

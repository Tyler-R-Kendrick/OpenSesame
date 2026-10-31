import {
  DEVICE_IDENTITY_KEY_PATH,
  deviceKeyField,
} from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import { genuineRecord } from "../__tests__/device-identity-records.js";
import * as deviceIdentity from "../device-identity-key.js";
import * as trust from "../device-identity-trust.js";
import { tombFileKey, vfsSeams } from "../vfs.js";
import { bodyPortOf } from "./store-device-key.js";
import { PASSWORD, newStore } from "./store-ops.fixture.js";
import {
  deferred,
  installUnlockRacesFixture,
  pendingTotp,
} from "./store-unlock-races.fixture.js";

installUnlockRacesFixture();

it("a retired device-key reconciliation cannot copy its private key into a newer guest", async () => {
  const { store, code } = await pendingTotp();
  await store.confirmTotp(await code());
  const record = await genuineRecord(Date.now() - 1_000);
  await deviceIdentity.writeStoredDeviceIdentityKey("personal", record);
  store.lock();
  await store.unlock(PASSWORD);
  const started = deferred();
  const gate = deferred();
  const read = deviceIdentity.readStoredDeviceIdentityKey;
  vi.spyOn(
    deviceIdentity,
    "readStoredDeviceIdentityKey",
  ).mockImplementationOnce(async (...args) => {
    const held = await read(...args);
    started.release();
    await gate.promise;
    return held;
  });
  const refused = expect(store.confirmTotp(await code())).rejects.toThrow(
    /no longer pending/,
  );
  await started.promise;
  try {
    store.lock();
    store.prepareGuestUnlock();
    await store.createGuest();
    gate.release();
    await refused;
    expect(store.isUnlocked()).toBe(true);
    expect(store.activeTomb()).not.toBe("personal");
    expect(bodyPortOf(store).body().deviceIdentityKey).toBeUndefined();
  } finally {
    gate.release();
    await refused;
  }
});

it("a retired validated identity cannot be installed into a destroyed and recreated tomb", async () => {
  const store = newStore();
  await store.create(PASSWORD);
  const carried = await genuineRecord(Date.now() - 2_000);
  await bodyPortOf(store).mutate((body) => {
    body.deviceIdentityKey = deviceKeyField(carried);
  });
  expect(
    await deviceIdentity.readStoredDeviceIdentityKey("personal"),
  ).toBeNull();
  store.lock();
  const started = deferred();
  const gate = deferred();
  const vet = trust.vetCarriedKey;
  let first = true;
  vi.spyOn(trust, "vetCarriedKey").mockImplementation(async (...args) => {
    const result = await vet(...args);
    if (first && result.kind === "trusted") {
      first = false;
      started.release();
      await gate.promise;
    }
    return result;
  });
  const refused = expect(store.unlock(PASSWORD)).rejects.toThrow(
    /no longer pending/,
  );
  await started.promise;
  try {
    await store.destroy();
    await store.create(PASSWORD);
    gate.release();
    await refused;
    expect(store.isUnlocked()).toBe(true);
    expect(
      await deviceIdentity.readStoredDeviceIdentityKey("personal"),
    ).toBeNull();
  } finally {
    gate.release();
    await refused;
  }
});

it("cancellation reaches the identity-file commit after its seal and queue admission", async () => {
  const store = newStore();
  await store.create(PASSWORD);
  const carried = await genuineRecord(Date.now() - 2_000);
  await bodyPortOf(store).mutate((body) => {
    body.deviceIdentityKey = deviceKeyField(carried);
  });
  store.lock();
  const started = deferred();
  const gate = deferred();
  const write = vfsSeams.writeRawGuarded;
  if (!write) throw new Error("Missing guarded storage fixture");
  const path = tombFileKey("personal", DEVICE_IDENTITY_KEY_PATH);
  vi.spyOn(vfsSeams, "writeRawGuarded").mockImplementation(async (...args) => {
    if (args[0] === path) {
      started.release();
      await gate.promise;
    }
    return write(...args);
  });
  const refused = expect(store.unlock(PASSWORD)).rejects.toThrow(
    /no longer pending/,
  );
  await started.promise;
  try {
    store.lock();
    gate.release();
    await refused;
    expect(vfsSeams.readRaw(path)).toBeNull();
    expect(store.isUnlocked()).toBe(false);
  } finally {
    gate.release();
    await refused;
  }
});

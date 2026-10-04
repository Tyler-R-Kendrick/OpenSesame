/**
 * A restore that takes the backup's identity, then a sync (ADR 0160 §5a). The
 * person's choice has to outlast the next merge on a device that still holds
 * the key it replaced; a merge keeps the older of two keys, so the key taken
 * is dated to outrank the one it replaced.
 */

/** @vitest-environment jsdom */
import { readDeviceIdentityKeyRecord } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { deviceKeyCarrier } from "../device-identity-carrier.js";
import { deviceVaultSeams } from "../device-identity-vault.js";
import { clearNotices, listNotices } from "../notices.js";
import {
  offlineBackupFile,
  sealedVaultText,
} from "../vault/offline-backup-file.js";
import { bodyPortOf } from "../vault/store-device-key.js";
import { adoptSnapshot } from "./adopt.js";
import { type Device, as, device } from "./devices.fixture.js";
import { memoryDrive } from "./drive.fixture.js";
import {
  PASSWORD,
  acting,
  connect,
  principalOf,
  sync,
} from "./identity-devices.fixture.js";

const OTHER_PASSWORD = "fourteen ungulate carriage nail";
const carrier = { ...deviceKeyCarrier };
const view = deviceVaultSeams.view;
let clock = Date.parse("2026-09-01T00:00:00.000Z");

function tick(): void {
  clock += 60_000;
  vi.setSystemTime(clock);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  clearNotices();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.assign(deviceKeyCarrier, carrier);
  deviceVaultSeams.view = view;
  clearNotices();
});

/** A laptop and a phone that share an empty vault whose key the laptop minted. */
async function pairedAndEmpty() {
  const drive = memoryDrive();
  const laptop = device("laptop");
  const phone = device("phone");
  await as(laptop, () => laptop.store.create(PASSWORD));
  const minted = await connect(laptop);
  await sync(laptop, drive);
  const snapshot = drive.snapshot;
  if (!snapshot) throw new Error("the laptop did not fill the drive");
  await as(phone, async () => {
    expect(await adoptSnapshot(snapshot)).toBe("adopted");
    phone.store.rehydrate();
    await phone.store.unlock(PASSWORD);
  });
  return { drive, laptop, phone, minted };
}

type Backup = { text: string; principalId: string };

/**
 * A backup from another vault whose key is newer than the one the laptop will
 * mint: made two hours on, then the clock is put back. Made first and its vault
 * locked, because every device here names its tomb the same and a vault that
 * stayed open would take the laptop's tomb key from under it.
 */
async function newerBackup(): Promise<Backup> {
  vi.setSystemTime(clock + 2 * 3_600_000);
  const source = device("source");
  await as(source, () => source.store.create(OTHER_PASSWORD));
  const { principalId } = await connect(source);
  const text = await as(source, async () => {
    await source.store.flushPendingWrites();
    const { header, tomb } = source.store.getSnapshot();
    const file = offlineBackupFile({
      status: "unlocked",
      guest: false,
      tomb,
      header,
    }).text;
    source.store.lock();
    return file;
  });
  vi.setSystemTime(clock);
  return { text: sealedVaultText(text), principalId };
}

const takenKeyId = (on: Device) =>
  readDeviceIdentityKeyRecord(bodyPortOf(on.store).body().deviceIdentityKey)
    ?.keyId;

describe("taking a backup's identity on a device that shares its vault", () => {
  it("survives the next sync: the other device converges on the key taken", async () => {
    const backup = await newerBackup();
    const { drive, laptop, phone, minted } = await pairedAndEmpty();
    expect(backup.principalId).not.toBe(minted.principalId);

    tick();
    await acting(laptop, () =>
      laptop.store.importSealed(backup.text, OTHER_PASSWORD, {
        adoptIdentity: true,
      }),
    );
    expect(await principalOf(laptop)).toBe(backup.principalId);

    for (const on of [laptop, phone, laptop, phone]) await sync(on, drive);

    expect(await principalOf(laptop)).toBe(backup.principalId);
    expect(await principalOf(phone)).toBe(backup.principalId);
    const keyId = backup.principalId.slice("prn_".length);
    await acting(laptop, async () => expect(takenKeyId(laptop)).toBe(keyId));
    await acting(phone, async () => expect(takenKeyId(phone)).toBe(keyId));
  });

  it("tells the phone once, and the laptop only that it took the key", async () => {
    const backup = await newerBackup();
    const { drive, laptop, phone } = await pairedAndEmpty();
    tick();
    await acting(laptop, () =>
      laptop.store.importSealed(backup.text, OTHER_PASSWORD, {
        adoptIdentity: true,
      }),
    );
    clearNotices();
    for (const on of [laptop, phone, laptop, phone]) await sync(on, drive);
    // The phone's key was replaced by a merge, which is the ranked notice.
    expect(listNotices().map((notice) => notice.title)).toEqual([
      "Device identity changed",
    ]);
  });
});

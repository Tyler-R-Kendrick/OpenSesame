/**
 * A restore that takes the backup's identity checks twice that it may (ADR 0160
 * §5a): once before it starts, and again under the locks, because another tab
 * can give the vault something in between; and it says the true thing when this
 * device's own key record is the one that cannot be read.
 */

/** @vitest-environment jsdom */
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { deviceKeyCarrier } from "../device-identity-carrier.js";
import {
  ensureDeviceIdentityKey,
  forgetDeviceIdentityKeyInFlightForTests,
} from "../device-identity-key.js";
import { kvDelete } from "../kv.js";
import { clearNotices, listNotices } from "../notices.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  readFile,
  tombFileKey,
  vfsFlush,
  writeFile,
} from "../vfs.js";
import { offlineBackupFile, sealedVaultText } from "./offline-backup-file.js";
import { bodyPortOf, installDeviceKeyCarrier } from "./store-device-key.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "fourteen ungulate carriage nail";
const KEY_FILE = "config/device-identity-key";
const TAKE = { adoptIdentity: true } as const;
const carrier = { ...deviceKeyCarrier };

function wipeDevice(): void {
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
    KEY_FILE,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  kvDelete(ATTEMPTS_KEY);
  forgetDeviceIdentityKeyInFlightForTests();
}

async function newVault(password: string): Promise<VaultStore> {
  const store = new VaultStore();
  await store.create(password);
  installDeviceKeyCarrier(() => bodyPortOf(store));
  return store;
}

const principal = async () =>
  (await ensureDeviceIdentityKey(PERSONAL_TOMB)).principalId;

async function settle(store: VaultStore): Promise<void> {
  await store.flushPendingWrites();
  await vfsFlush();
}

type KeyedBackup = { text: string; id: string };

/** A backup of a vault that has its own identity key. */
async function backupWithKey(): Promise<KeyedBackup> {
  const source = await newVault(PASSWORD);
  const id = await principal();
  await settle(source);
  const { header, tomb } = source.getSnapshot();
  const text = offlineBackupFile({
    status: "unlocked",
    guest: false,
    tomb,
    header,
  }).text;
  source.lock();
  wipeDevice();
  return { text: sealedVaultText(text), id };
}

beforeEach(async () => {
  await vfsFlush();
  wipeDevice();
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  clearNotices();
});

afterEach(async () => {
  await vfsFlush();
  vi.unstubAllGlobals();
  Object.assign(deviceKeyCarrier, carrier);
  clearNotices();
});

describe("a vault another tab gave something to after the choice was made", () => {
  it("refuses, puts the tomb's key back, and leaves the other tab's edit alone", async () => {
    const backup = await backupWithKey();
    const tabA = await newVault(OTHER_PASSWORD);
    const own = await principal();
    await settle(tabA);

    // Tab B opens the same vault and writes: tab A still holds an empty body.
    const tabB = new VaultStore();
    tabB.rehydrate();
    await tabB.unlock(OTHER_PASSWORD);
    await tabB.saveItem(createItem("note", "Written in tab B"));
    await settle(tabB);
    expect(tabA.getSnapshot().items).toHaveLength(0);

    await expect(
      tabA.importSealed(backup.text, PASSWORD, TAKE),
    ).rejects.toThrow("changed in another tab");
    forgetDeviceIdentityKeyInFlightForTests();

    expect(await principal()).toBe(own);
    expect(own).not.toBe(backup.id);
    expect(listNotices()).toEqual([]);
    await settle(tabA);
    const next = new VaultStore();
    next.rehydrate();
    await next.unlock(OTHER_PASSWORD);
    expect(next.getSnapshot().items.map((item) => item.name)).toEqual([
      "Written in tab B",
    ]);
  });
});

describe("a browser with no Web Locks", () => {
  it("ignores the choice: the backup's key is not taken and the vault's tomb is left without one", async () => {
    const backup = await backupWithKey();
    vi.stubGlobal("navigator", {});
    const target = await newVault(OTHER_PASSWORD);

    await target.importSealed(backup.text, PASSWORD, TAKE);

    await expect(readFile(PERSONAL_TOMB, KEY_FILE)).rejects.toMatchObject({
      code: "not-found",
    });
    expect(bodyPortOf(target).body().deviceIdentityKey).toBeUndefined();
    expect(listNotices()).toEqual([]);
  });
});

describe("a device whose own key record cannot be read", () => {
  it("takes nothing, leaves the record as it is, and does not call the backup's key unusable", async () => {
    const backup = await backupWithKey();
    const target = await newVault(OTHER_PASSWORD);
    const garbage = new TextEncoder().encode("{ not a key record");
    await writeFile(PERSONAL_TOMB, KEY_FILE, garbage);

    const added = await target.importSealed(backup.text, PASSWORD, TAKE);

    expect(added).toBe(0);
    expect(
      new TextDecoder().decode(await readFile(PERSONAL_TOMB, KEY_FILE)),
    ).toBe("{ not a key record");
    expect(listNotices()).toHaveLength(1);
    const [notice] = listNotices();
    expect(notice?.title).toBe("Identity key not taken");
    expect(notice?.body).toContain("own identity key could not be read");
    expect(notice?.body).not.toContain("cannot use");
    expect(notice?.body).not.toContain("backup was made under");
  });
});

/**
 * The device identity key through backup and restore (ADR 0160 §5): an
 * offline backup carries it sealed in the body, a restore on another device
 * keeps the principal, a backup without it mints one exactly once and says so,
 * and importing someone else's items never takes their identity.
 */

/** @vitest-environment jsdom */
import { createItem, openVaultFile } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { deviceKeyCarrier } from "../device-identity-carrier.js";
import {
  ensureDeviceIdentityKey,
  forgetDeviceIdentityKeyInFlightForTests,
  readDeviceIdentityKey,
} from "../device-identity-key.js";
import { kvDelete } from "../kv.js";
import { clearNotices, listNotices } from "../notices.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { offlineBackupFile, sealedVaultText } from "./offline-backup-file.js";
import { installDeviceKeyCarrier } from "./store-device-key.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "fourteen ungulate carriage nail";
const KEY_FILE = "config/device-identity-key";
const carrier = { ...deviceKeyCarrier };
let locks = webLocksDouble();

/** The device forgets its vault and its key: a wiped browser, or a new phone. */
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
  installDeviceKeyCarrier(() => store.bodyPort());
  return store;
}

const principal = async () =>
  (await ensureDeviceIdentityKey(PERSONAL_TOMB)).principalId;

function backupOf(store: VaultStore): string {
  const { header, tomb } = store.getSnapshot();
  return offlineBackupFile({ status: "unlocked", guest: false, tomb, header })
    .text;
}

beforeEach(async () => {
  await vfsFlush();
  wipeDevice();
  locks = webLocksDouble();
  vi.stubGlobal("navigator", { locks });
  clearNotices();
});

afterEach(async () => {
  await vfsFlush();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.assign(deviceKeyCarrier, carrier);
  clearNotices();
});

describe("an offline backup", () => {
  it("lists the key by name and holds nothing of it in the clear", async () => {
    const source = await newVault(PASSWORD);
    await source.saveItem(createItem("note", "Router"));
    const key = await ensureDeviceIdentityKey(PERSONAL_TOMB);
    await source.flushPendingWrites();
    const text = backupOf(source);
    expect(text).not.toContain(key.keyId);
    expect(text).not.toContain("privateJwkJson");
    const opened = await openVaultFile(text, PASSWORD);
    expect(opened.concealed).toEqual([KEY_FILE]);
    expect(opened.items.map((item) => item.name)).toEqual(["Router"]);
    expect(JSON.stringify(opened)).not.toContain(key.keyId);
  });

  it("restored on another device keeps the same principal", async () => {
    const source = await newVault(PASSWORD);
    await source.saveItem(createItem("note", "Router"));
    const original = await principal();
    await source.flushPendingWrites();
    const backup = backupOf(source);
    source.lock();

    wipeDevice();
    const target = await newVault(OTHER_PASSWORD);
    await target.importSealed(sealedVaultText(backup), PASSWORD);
    expect(await principal()).toBe(original);
    expect(target.getSnapshot().items.map((item) => item.name)).toEqual([
      "Router",
    ]);
    // Restoring with the key is not a change worth a notice.
    expect(listNotices()).toEqual([]);
  });

  it("restored over a key this vault already minted takes the backup's, and says so", async () => {
    const source = await newVault(PASSWORD);
    const original = await principal();
    await source.flushPendingWrites();
    const backup = backupOf(source);
    source.lock();

    wipeDevice();
    const target = await newVault(OTHER_PASSWORD);
    const minted = await principal();
    expect(minted).not.toBe(original);
    await target.importSealed(sealedVaultText(backup), PASSWORD);
    expect(await principal()).toBe(original);
    expect(listNotices().map((notice) => notice.title)).toEqual([
      "Device identity changed",
    ]);
  });

  it("restored again over its own vault changes nothing", async () => {
    const store = await newVault(PASSWORD);
    const original = await principal();
    await store.flushPendingWrites();
    const backup = backupOf(store);
    await store.importSealed(sealedVaultText(backup), PASSWORD);
    expect(await principal()).toBe(original);
    expect(listNotices()).toEqual([]);
  });
});

describe("a backup made before keys travelled", () => {
  async function keylessBackup(): Promise<string> {
    const source = await newVault(PASSWORD);
    await source.saveItem(createItem("note", "Router"));
    await source.flushPendingWrites();
    const text = backupOf(source);
    source.lock();
    return text;
  }

  it("mints one key, once, under the lock, and tells the person the principal differs", async () => {
    const backup = await keylessBackup();
    wipeDevice();
    const target = await newVault(OTHER_PASSWORD);
    const generated = vi.spyOn(crypto.subtle, "generateKey");
    await target.importSealed(sealedVaultText(backup), PASSWORD);
    const minted = await principal();
    // A second read mints nothing more.
    expect(await principal()).toBe(minted);
    expect(generated).toHaveBeenCalledTimes(1);
    expect(
      locks.requested.some((name) =>
        name.startsWith("opensesame-device-identity-"),
      ),
    ).toBe(true);
    generated.mockRestore();
    expect(listNotices().map((notice) => notice.title)).toEqual([
      "Restored without an identity key",
    ]);
    // And from now on it travels: the next backup carries it.
    await target.flushPendingWrites();
    const next = await openVaultFile(backupOf(target), OTHER_PASSWORD);
    expect(next.concealed).toEqual([KEY_FILE]);
  });

  it("with no cross-tab lock mints nothing and announces nothing", async () => {
    const backup = await keylessBackup();
    wipeDevice();
    vi.stubGlobal("navigator", {});
    const target = await newVault(OTHER_PASSWORD);
    await target.importSealed(sealedVaultText(backup), PASSWORD);
    expect(await readDeviceIdentityKey(PERSONAL_TOMB)).toBeNull();
    expect(listNotices()).toEqual([]);
  });
});

describe("importing someone else's items", () => {
  it("merges the items and never the identity", async () => {
    const source = await newVault(PASSWORD);
    await source.saveItem(createItem("note", "Theirs"));
    await principal();
    await source.flushPendingWrites();
    const backup = backupOf(source);
    source.lock();

    wipeDevice();
    const target = await newVault(OTHER_PASSWORD);
    await target.saveItem(createItem("note", "Mine"));
    const mine = await principal();
    await target.importSealed(sealedVaultText(backup), PASSWORD);
    expect(
      target
        .getSnapshot()
        .items.map((item) => item.name)
        .sort(),
    ).toEqual(["Mine", "Theirs"]);
    expect(await principal()).toBe(mine);
    expect(listNotices()).toEqual([]);
  });
});

describe("a guest", () => {
  it("keeps its key in its own tomb and carries none in a body", async () => {
    const store = new VaultStore();
    installDeviceKeyCarrier(() => store.bodyPort());
    await store.createGuest();
    const key = await ensureDeviceIdentityKey(GUEST_TOMB);
    expect(key.principalId).toMatch(/^prn_/);
    expect(store.bodyPort().body().deviceIdentityKey).toBeUndefined();
  });

  it("starts the next guest with no key of the last one's", async () => {
    const first = new VaultStore();
    installDeviceKeyCarrier(() => first.bodyPort());
    await first.createGuest();
    const before = await ensureDeviceIdentityKey(GUEST_TOMB);
    first.lock();
    forgetDeviceIdentityKeyInFlightForTests();

    const second = new VaultStore();
    installDeviceKeyCarrier(() => second.bodyPort());
    await second.createGuest();
    // The earlier guest's sealed key is ciphertext under a dead key: it is
    // wiped with the tomb, so the new guest mints its own instead of failing.
    const after = await ensureDeviceIdentityKey(GUEST_TOMB);
    expect(after.principalId).not.toBe(before.principalId);
  });
});

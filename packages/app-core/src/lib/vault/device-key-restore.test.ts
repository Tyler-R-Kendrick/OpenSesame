/**
 * The device identity key through backup and restore (ADR 0160 §5a): an
 * offline backup carries it sealed in the body; a restore takes it only when
 * the person asks and the vault has done nothing yet, and then keeps the
 * principal; a backup without a usable key leaves the vault its own and says
 * so; a failed restore leaves the vault as it was.
 */

/** @vitest-environment jsdom */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  createItem,
  deviceKeyField,
  openVaultFile,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { genuineRecord } from "../__tests__/device-identity-records.js";
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
  vfsSeams,
} from "../vfs.js";
import { offlineBackupFile, sealedVaultText } from "./offline-backup-file.js";
import { bodyPortOf, installDeviceKeyCarrier } from "./store-device-key.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "fourteen ungulate carriage nail";
const KEY_FILE = "config/device-identity-key";
const TAKE = { adoptIdentity: true } as const;
const carrier = { ...deviceKeyCarrier };

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
  installDeviceKeyCarrier(() => bodyPortOf(store));
  return store;
}

const principal = async () =>
  (await ensureDeviceIdentityKey(PERSONAL_TOMB)).principalId;

function backupOf(store: VaultStore): string {
  const { header, tomb } = store.getSnapshot();
  return offlineBackupFile({ status: "unlocked", guest: false, tomb, header })
    .text;
}

/** A backup whose body carries `field` as its key, whatever that is. */
async function backupCarrying(field: BoundaryValue): Promise<string> {
  const source = await newVault(PASSWORD);
  await bodyPortOf(source).mutate((body) => {
    // The body is JSON from anywhere: put in it whatever the test names.
    Object.assign(body, { deviceIdentityKey: field });
  });
  await source.flushPendingWrites();
  await vfsFlush();
  const text = backupOf(source);
  source.lock();
  return text;
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
});

describe("restoring on another device", () => {
  async function original() {
    const source = await newVault(PASSWORD);
    await source.saveItem(createItem("note", "Router"));
    const id = await principal();
    await source.flushPendingWrites();
    const backup = backupOf(source);
    source.lock();
    wipeDevice();
    return { id, backup };
  }

  it("keeps the principal when the person takes the backup's identity", async () => {
    const { id, backup } = await original();
    const target = await newVault(OTHER_PASSWORD);
    await target.importSealed(sealedVaultText(backup), PASSWORD, TAKE);
    expect(await principal()).toBe(id);
    expect(target.getSnapshot().items.map((item) => item.name)).toEqual([
      "Router",
    ]);
    // Nothing was lost, so no one is told.
    expect(listNotices()).toEqual([]);
  });

  it("leaves the vault its own principal when the person does not", async () => {
    const { id, backup } = await original();
    const target = await newVault(OTHER_PASSWORD);
    await target.importSealed(sealedVaultText(backup), PASSWORD);
    expect(target.getSnapshot().items).toHaveLength(1);
    expect(await principal()).not.toBe(id);
    expect(listNotices()).toEqual([]);
  });

  it("replaces the key a fresh vault already minted, ends its sessions' key and says what happened", async () => {
    const { id, backup } = await original();
    const target = await newVault(OTHER_PASSWORD);
    const minted = await principal();
    expect(minted).not.toBe(id);
    await target.importSealed(sealedVaultText(backup), PASSWORD, TAKE);
    expect(await principal()).toBe(id);
    expect(listNotices().map((notice) => notice.title)).toEqual([
      "Device identity changed",
    ]);
    expect(listNotices()[0]?.body).toContain("You took the backup's");
    // The body carries it too, so the next backup does.
    await target.flushPendingWrites();
    const next = await openVaultFile(backupOf(target), OTHER_PASSWORD);
    expect(next.concealed).toEqual([KEY_FILE]);
  });

  it("is offered only to a vault that has done nothing: with content the choice is ignored", async () => {
    const { id, backup } = await original();
    const target = await newVault(OTHER_PASSWORD);
    await target.saveItem(createItem("note", "Mine"));
    const mine = await principal();
    await target.importSealed(sealedVaultText(backup), PASSWORD, TAKE);
    expect(
      target
        .getSnapshot()
        .items.map((item) => item.name)
        .sort(),
    ).toEqual(["Mine", "Router"]);
    expect(await principal()).toBe(mine);
    expect(mine).not.toBe(id);
    expect(listNotices()).toEqual([]);
  });

  it("restored over its own vault changes nothing and says nothing", async () => {
    const store = await newVault(PASSWORD);
    const id = await principal();
    await store.flushPendingWrites();
    const backup = backupOf(store);
    await store.importSealed(sealedVaultText(backup), PASSWORD, TAKE);
    expect(await principal()).toBe(id);
    expect(listNotices()).toEqual([]);
  });
});

describe("a backup without a key this vault can take", () => {
  it("made before keys travelled: mints one key, once, under the lock, and says the backup carried none", async () => {
    const backup = await backupCarrying(undefined);
    wipeDevice();
    const target = await newVault(OTHER_PASSWORD);
    const generated = vi.spyOn(crypto.subtle, "generateKey");
    await target.importSealed(sealedVaultText(backup), PASSWORD, TAKE);
    const minted = await principal();
    expect(await principal()).toBe(minted);
    expect(generated).toHaveBeenCalledTimes(1);
    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]).toMatchObject({
      title: "Restored without an identity key",
      body: expect.stringContaining("carries no identity key"),
    });
    await target.flushPendingWrites();
    const next = await openVaultFile(backupOf(target), OTHER_PASSWORD);
    expect(next.concealed).toEqual([KEY_FILE]);
  });

  it("carrying a newer version's record or a forgery: the vault keeps its own and the notice says it could not be used", async () => {
    const genuine = await genuineRecord(Date.now() - 1000);
    const unusable = [
      { version: 2, from: "a newer build" },
      deviceKeyField({ ...genuine, keyId: "F".repeat(43), createdAt: 1 }),
      "a key",
    ];
    for (const field of unusable) {
      const backup = await backupCarrying(field);
      wipeDevice();
      clearNotices();
      const target = await newVault(OTHER_PASSWORD);
      const own = await principal();
      await target.importSealed(sealedVaultText(backup), PASSWORD, TAKE);
      expect(await principal()).toBe(own);
      expect(listNotices()).toHaveLength(1);
      expect(listNotices()[0]).toMatchObject({
        title: "Identity key not taken",
        body: expect.stringContaining("cannot use"),
      });
      expect(listNotices()[0]?.body).not.toContain("carries no identity key");
      target.lock();
      wipeDevice();
    }
  });

  it("with no cross-tab lock mints nothing and announces nothing", async () => {
    const backup = await backupCarrying(undefined);
    wipeDevice();
    vi.stubGlobal("navigator", {});
    const target = await newVault(OTHER_PASSWORD);
    await target.importSealed(sealedVaultText(backup), PASSWORD, TAKE);
    expect(await readDeviceIdentityKey(PERSONAL_TOMB)).toBeNull();
    expect(listNotices()).toEqual([]);
  });
});

describe("a restore that cannot finish", () => {
  /** Fail every write of the vault body, as a full disk would. */
  function failBodyWrites(): () => void {
    const write = vfsSeams.writeRaw;
    vfsSeams.writeRaw = (key, value) =>
      key.endsWith(`/${BODY_PATH}`)
        ? Promise.reject(new Error("disk full"))
        : write(key, value);
    return () => {
      vfsSeams.writeRaw = write;
    };
  }

  it("leaves the vault with the key it had, in the tomb and in the body, and fails loudly", async () => {
    const source = await newVault(PASSWORD);
    const theirs = await principal();
    await source.flushPendingWrites();
    const backup = backupOf(source);
    source.lock();
    wipeDevice();

    const target = await newVault(OTHER_PASSWORD);
    const own = await principal();
    await target.flushPendingWrites();
    const bodyKey = bodyPortOf(target).body().deviceIdentityKey;
    const restore = failBodyWrites();
    try {
      await expect(
        target.importSealed(sealedVaultText(backup), PASSWORD, TAKE),
      ).rejects.toThrow("disk full");
    } finally {
      restore();
    }
    forgetDeviceIdentityKeyInFlightForTests();
    expect(await principal()).toBe(own);
    expect(own).not.toBe(theirs);
    expect(bodyPortOf(target).body().deviceIdentityKey).toEqual(bodyKey);
    expect(listNotices()).toEqual([]);
  });

  it("leaves a vault that had no key without one", async () => {
    const source = await newVault(PASSWORD);
    const theirs = await principal();
    await source.flushPendingWrites();
    const backup = backupOf(source);
    source.lock();
    wipeDevice();

    const target = await newVault(OTHER_PASSWORD);
    const restore = failBodyWrites();
    try {
      await expect(
        target.importSealed(sealedVaultText(backup), PASSWORD, TAKE),
      ).rejects.toThrow("disk full");
    } finally {
      restore();
    }
    forgetDeviceIdentityKeyInFlightForTests();
    expect(await readDeviceIdentityKey(PERSONAL_TOMB)).toBeNull();
    expect(bodyPortOf(target).body().deviceIdentityKey).toBeUndefined();
    expect(await principal()).not.toBe(theirs);
  });
});

describe("a guest", () => {
  it("keeps its key in its own tomb and carries none in a body", async () => {
    const store = new VaultStore();
    installDeviceKeyCarrier(() => bodyPortOf(store));
    await store.createGuest();
    const key = await ensureDeviceIdentityKey(GUEST_TOMB);
    expect(key.principalId).toMatch(/^prn_/);
    expect(bodyPortOf(store).body().deviceIdentityKey).toBeUndefined();
  });

  it("starts the next guest with no key of the last one's", async () => {
    const first = new VaultStore();
    installDeviceKeyCarrier(() => bodyPortOf(first));
    await first.createGuest();
    const before = await ensureDeviceIdentityKey(GUEST_TOMB);
    first.lock();
    forgetDeviceIdentityKeyInFlightForTests();

    const second = new VaultStore();
    installDeviceKeyCarrier(() => bodyPortOf(second));
    await second.createGuest();
    // The earlier guest's sealed key is ciphertext under a dead key: it is
    // wiped with the tomb, so the new guest mints its own instead of failing.
    const after = await ensureDeviceIdentityKey(GUEST_TOMB);
    expect(after.principalId).not.toBe(before.principalId);
  });
});

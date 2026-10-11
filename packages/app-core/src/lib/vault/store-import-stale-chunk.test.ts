/**
 * A restore from a tab that outlived the deploy that replaced its chunks (the
 * identity modules load when a restore needs them). Decryption is real
 * WebCrypto throughout: only the fetch of a chunk is made to fail.
 *
 * Before anything is written, a chunk that cannot load stops the restore with
 * the vault as it was. After, nothing may turn a restore that wrote into one
 * that reports failure.
 */

/** @vitest-environment jsdom */
import { WrongPasswordError, createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { STALE_BUILD, isChunkLoadFailure } from "../chunk-load.js";
import { deviceKeyCarrier } from "../device-identity-carrier.js";
import { forgetDeviceIdentityKeyInFlightForTests } from "../device-identity-key.js";
import { kvDelete } from "../kv.js";
import { clearNotices, listNotices } from "../notices.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { offlineBackupFile, sealedVaultText } from "./offline-backup-file.js";
import { bodyPortOf, installDeviceKeyCarrier } from "./store-device-key.js";
import { storeImportSeams } from "./store-import.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const SOURCE_PIN = "48291037";
const TARGET_PIN = "13579246";
const TAKE = { adoptIdentity: true } as const;
const carrier = { ...deviceKeyCarrier };
const seams = { ...storeImportSeams };

const GONE = new TypeError(
  "Failed to fetch dynamically imported module: https://example.test/OpenSesame/assets/device-identity-carry-Bvwzak28.js",
);
const unreachable = () => Promise.reject(GONE);

function wipeDevice(): void {
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

async function settle(store: VaultStore): Promise<void> {
  await store.flushPendingWrites();
  await vfsFlush();
}

/** A PIN-sealed backup holding one note, as the Export key writes it. */
async function pinBackup(): Promise<string> {
  const source = new VaultStore();
  await source.createWithPin(SOURCE_PIN);
  await source.saveItem(createItem("note", "Canary"));
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
  return sealedVaultText(text);
}

async function freshVault(): Promise<VaultStore> {
  const store = new VaultStore();
  await store.createWithPin(TARGET_PIN);
  installDeviceKeyCarrier(() => bodyPortOf(store));
  return store;
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
  Object.assign(storeImportSeams, seams);
  clearNotices();
});

describe("restoring a PIN backup", () => {
  it("opens it with its own PIN and brings its items in", async () => {
    const backup = await pinBackup();
    const target = await freshVault();

    await expect(target.importSealed(backup, SOURCE_PIN)).resolves.toBe(1);

    expect(target.getSnapshot().items.map((item) => item.name)).toEqual([
      "Canary",
    ]);
  });

  it("refuses a PIN that is well formed but not the backup's, and writes nothing", async () => {
    const backup = await pinBackup();
    const target = await freshVault();

    // The target's own PIN is a real PIN; it simply is not this backup's.
    await expect(target.importSealed(backup, TARGET_PIN)).rejects.toThrow(
      WrongPasswordError,
    );

    expect(target.getSnapshot().items).toEqual([]);
  });
});

describe("a chunk that cannot load before the restore has written", () => {
  it("stops a restore that takes the identity, with the vault as it was", async () => {
    const backup = await pinBackup();
    const target = await freshVault();
    storeImportSeams.trust = unreachable;

    await expect(
      target.importSealed(backup, SOURCE_PIN, TAKE),
    ).rejects.toSatisfy(isChunkLoadFailure);

    expect(target.getSnapshot().items).toEqual([]);
    expect(listNotices()).toEqual([]);
  });

  it("is retried whole once the page is current", async () => {
    const backup = await pinBackup();
    const target = await freshVault();
    storeImportSeams.trust = unreachable;
    await target.importSealed(backup, SOURCE_PIN, TAKE).catch(() => undefined);

    Object.assign(storeImportSeams, seams);

    await expect(target.importSealed(backup, SOURCE_PIN, TAKE)).resolves.toBe(
      1,
    );
    expect(target.getSnapshot().items.map((item) => item.name)).toEqual([
      "Canary",
    ]);
  });

  it("does not touch a restore that never asks for the identity", async () => {
    const backup = await pinBackup();
    const target = await freshVault();
    Object.assign(storeImportSeams, {
      trust: unreachable,
      keys: unreachable,
      carry: unreachable,
    });

    await expect(target.importSealed(backup, SOURCE_PIN)).resolves.toBe(1);
    expect(target.getSnapshot().items.map((item) => item.name)).toEqual([
      "Canary",
    ]);
  });
});

describe("a chunk that cannot load after the restore has written", () => {
  it("still reports the restore it made, and says what it could not", async () => {
    const backup = await pinBackup();
    const target = await freshVault();
    // The backup carries no identity key, so this restore mints one and tells
    // the person so: the notice is the part that cannot load.
    storeImportSeams.carry = unreachable;

    await expect(target.importSealed(backup, SOURCE_PIN, TAKE)).resolves.toBe(
      1,
    );

    expect(target.getSnapshot().items.map((item) => item.name)).toEqual([
      "Canary",
    ]);
    const [notice] = listNotices();
    expect(notice?.title).toBe("Restored");
    expect(notice?.body).toContain("identity key");
    expect(notice?.body).not.toContain("http");
  });

  it("is told to the person as the page being out of date", () => {
    expect(STALE_BUILD).toContain("out of date");
  });
});

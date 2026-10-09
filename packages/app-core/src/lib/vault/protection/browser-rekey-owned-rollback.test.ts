/** Actual AES/storage/owner controls; only physical IO completion and failure are held. */
import * as vaultCore from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { kvDelete, kvGet } from "../../kv.js";
import { writeLastVaultId } from "../../last-vault.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  SEAL_BOUND_MARKER_PATH,
  readFile,
  tombFileKey,
  vfsFlush,
  vfsSeams,
  writeFile,
} from "../../vfs.js";
import { ATTEMPTS_KEY, VaultStore } from "../store.js";
import { LEGACY_PREFS_KEY } from "../tomb-migration.js";
import { verifyManifestAuth } from "./manifest-auth.js";

const PASSWORD = "correct horse battery staple";
const FILE_PATH = "settings/owned-rollback";
const FILE_KEY = tombFileKey(PERSONAL_TOMB, FILE_PATH);
const INDEX_KEY = tombFileKey(PERSONAL_TOMB, INDEX_PATH);
const ORIGINAL_BYTES = new Uint8Array([9, 8, 7, 6]);
const PEER_BYTES = new Uint8Array([1, 3, 5, 7, 9]);
const stores: VaultStore[] = [];
const roots: Uint8Array[] = [];
const operations: Promise<void>[] = [];
const releases: (() => void)[] = [];

function track(operation: Promise<void>): Promise<void> {
  operations.push(operation);
  return operation;
}

function gate() {
  let announce = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { entered, held, announce, release };
}

async function owner() {
  const store = new VaultStore();
  stores.push(store);
  await store.create(PASSWORD);
  const item = vaultCore.createItem("note", "rekey ownership control");
  item.notes = "the original owner BODY survives failed file publication";
  await store.saveItem(item);
  await writeFile(PERSONAL_TOMB, FILE_PATH, ORIGINAL_BYTES);
  await store.protection.ensureProtectionProjected();
  await vfsFlush();
  const header = store.getSnapshot().header;
  if (!header?.protection)
    throw new Error("The genuine owner has no protection manifest.");
  const root = await vaultCore.unwrapRawVaultKeyFromPassword(header, PASSWORD);
  roots.push(root);
  await verifyManifestAuth(root, header.protection);
  const key = await vaultCore.importVaultKey(root);
  return { store, item, key, epoch: header.protection.rootEpoch };
}

async function reopen(
  item: vaultCore.VaultItem,
  expected: Uint8Array,
): Promise<VaultStore> {
  const fresh = new VaultStore();
  stores.push(fresh);
  await fresh.unlock(PASSWORD);
  expect(fresh.getSnapshot().status).toBe("unlocked");
  expect(
    fresh.getSnapshot().items.find((entry) => entry.id === item.id)?.notes,
  ).toBe(item.notes);
  expect(await readFile(PERSONAL_TOMB, FILE_PATH)).toEqual(expected);
  return fresh;
}

function observePublication(store: VaultStore, failIndex: boolean) {
  const delivery = gate();
  const actualWrite = vfsSeams.writeRaw;
  const fileWrites: string[] = [];
  const epochs: (number | undefined)[] = [];
  let first = true;
  let indexFailures = 0;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (...args) => {
    const [key, value] = args;
    if (key === INDEX_KEY && !first && failIndex) {
      indexFailures++;
      throw new Error("Controlled physical index write failure.");
    }
    const pause = key === FILE_KEY && first;
    if (key === FILE_KEY) {
      first = false;
      fileWrites.push(value);
      epochs.push(store.getSnapshot().header?.protection?.rootEpoch);
    }
    await actualWrite(...args);
    if (pause) {
      delivery.announce();
      await delivery.held;
    }
  });
  return {
    delivery,
    actualWrite,
    fileWrites,
    epochs,
    indexFailures: () => indexFailures,
  };
}

beforeEach(async () => {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
    SEAL_BOUND_MARKER_PATH,
    FILE_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  kvDelete(LEGACY_PREFS_KEY);
  writeLastVaultId(PERSONAL_TOMB);
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(operations.splice(0));
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) root.fill(0);
  for (const store of stores.splice(0)) store.lock();
  await vfsFlush();
});

it("preserves a genuine physical peer's newer file when a later rotation write fails, instead of restoring obsolete ciphertext", async () => {
  const { store, item, key } = await owner();
  const obsolete = kvGet(FILE_KEY);
  if (obsolete === null) throw new Error("The original file is missing.");
  const observed = observePublication(store, true);
  const rotating = track(
    store.protection.rotateCompromisedRoot({ password: PASSWORD }),
  );
  const refusal = expect(rotating).rejects.toBeInstanceOf(Error);
  try {
    await observed.delivery.entered;
    const peer = await vaultCore.sealJson(
      key,
      { v: 1, dataB64: vaultCore.bytesToB64(PEER_BYTES) },
      vaultCore.vaultSealBinding(PERSONAL_TOMB, FILE_PATH),
    );
    vaultCore.assertSealed(peer);
    const peerRaw = JSON.stringify(peer);
    await observed.actualWrite(FILE_KEY, peerRaw, key);
    expect(kvGet(FILE_KEY)).toBe(peerRaw);
    observed.delivery.release();
    await refusal;
    expect(observed.indexFailures()).toBeGreaterThan(0);
    expect(observed.fileWrites).not.toContain(obsolete);
    vi.restoreAllMocks();
    store.lock();
    await reopen(item, PEER_BYTES);
  } finally {
    observed.delivery.release();
    await refusal.catch(() => undefined);
  }
});

it("restores the original genuine file and owner BODY on an ordinary later index failure with no peer displacement", async () => {
  const { store, item } = await owner();
  const observed = observePublication(store, true);
  const rotating = track(
    store.protection.rotateCompromisedRoot({ password: PASSWORD }),
  );
  const refusal = expect(rotating).rejects.toBeInstanceOf(Error);
  try {
    await observed.delivery.entered;
    observed.delivery.release();
    await refusal;
    expect(observed.indexFailures()).toBeGreaterThan(0);
    vi.restoreAllMocks();
    store.lock();
    await reopen(item, ORIGINAL_BYTES);
  } finally {
    observed.delivery.release();
    await refusal.catch(() => undefined);
  }
});

it("publishes a queued ordinary file write only after the complete genuine rotation and reopens it under the new authenticated root", async () => {
  const { store, item, epoch } = await owner();
  const observed = observePublication(store, false);
  const rotating = track(
    store.protection.rotateCompromisedRoot({ password: PASSWORD }),
  );
  let writing: Promise<void> | null = null;
  try {
    await observed.delivery.entered;
    writing = track(writeFile(PERSONAL_TOMB, FILE_PATH, PEER_BYTES));
    observed.delivery.release();
    await rotating;
    await writing;
    expect(observed.epochs).toEqual([epoch, epoch + 1]);
    expect(store.getSnapshot().header?.protection?.rootEpoch).toBe(epoch + 1);
    vi.restoreAllMocks();
    store.lock();
    const fresh = await reopen(item, PEER_BYTES);
    expect(fresh.getSnapshot().header?.protection?.rootEpoch).toBe(epoch + 1);
  } finally {
    observed.delivery.release();
    await Promise.allSettled(writing ? [rotating, writing] : [rotating]);
  }
});

it("closes only the failed original rotation session when the new genuine HEADER was physically accepted before a completion error", async () => {
  const { store, item, epoch } = await owner();
  const { isJsonObject } = await import("@opensesame/os-domain");
  const actualWrite = vfsSeams.writeRaw;
  const headerKey = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
  let accepted = false;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (...args) => {
    const [key, value] = args;
    let fail = false;
    if (!accepted && key === headerKey) {
      const emitted: import("@opensesame/os-domain").BoundaryValue =
        JSON.parse(value);
      fail =
        isJsonObject(emitted) &&
        isJsonObject(emitted.protection) &&
        emitted.protection.rootEpoch === epoch + 1;
    }
    await actualWrite(...args);
    if (fail) {
      accepted = true;
      expect(kvGet(headerKey)).toBe(value);
      throw new Error(
        "Controlled completion error after new HEADER publication.",
      );
    }
  });
  await expect(
    track(store.protection.rotateCompromisedRoot({ password: PASSWORD })),
  ).rejects.toBeInstanceOf(Error);
  expect(accepted).toBe(true);
  expect(store.getSnapshot().status).toBe("locked");
  vi.restoreAllMocks();
  const fresh = await reopen(item, ORIGINAL_BYTES);
  expect(fresh.getSnapshot().header?.protection?.rootEpoch).toBe(epoch + 1);
});

it("keeps the genuine rotated password wrap authoritative after accepted HEADER failure and a real sealed snapshot merge", async () => {
  const { store, item, epoch } = await owner();
  await store.changeMasterPassword(PASSWORD, PASSWORD);
  await store.protection.ensureProtectionProjected();
  await vfsFlush();
  const seeded = await store.sealedSnapshot();
  const seedRoot = await vaultCore.unwrapRawVaultKeyFromPassword(
    seeded.header,
    PASSWORD,
  );
  roots.push(seedRoot);
  const seedKey = await vaultCore.importVaultKey(seedRoot);
  const seedBody = await vaultCore.openJson<vaultCore.VaultBody>(
    seedKey,
    seeded.body,
    vaultCore.vaultSealBinding(seeded.tomb, BODY_PATH),
  );
  expect(seedBody.masterWrap?.wrap).toEqual(seeded.header.wrap);
  expect(seedBody.masterWrap?.kdf).toEqual(seeded.header.kdf);
  const { isJsonObject } = await import("@opensesame/os-domain");
  const actualWrite = vfsSeams.writeRaw;
  const headerKey = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
  let accepted = false;
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (...args) => {
    const [key, value] = args;
    let fail = false;
    if (!accepted && key === headerKey) {
      const emitted: import("@opensesame/os-domain").BoundaryValue =
        JSON.parse(value);
      fail =
        isJsonObject(emitted) &&
        isJsonObject(emitted.protection) &&
        emitted.protection.rootEpoch === epoch + 1;
    }
    await actualWrite(...args);
    if (fail) {
      accepted = true;
      expect(kvGet(headerKey)).toBe(value);
      throw new Error(
        "Controlled completion error after new HEADER publication.",
      );
    }
  });
  await expect(
    track(store.protection.rotateCompromisedRoot({ password: PASSWORD })),
  ).rejects.toBeInstanceOf(Error);
  expect(accepted).toBe(true);
  expect(store.getSnapshot().status).toBe("locked");
  vi.restoreAllMocks();
  const fresh = await reopen(item, ORIGINAL_BYTES);
  const snapshot = await fresh.sealedSnapshot();
  await fresh.mergeSnapshot({
    tomb: snapshot.tomb,
    createdAt: snapshot.header.createdAt,
    body: snapshot.body,
    rev: snapshot.rev,
  });
  expect(fresh.getSnapshot().header?.wrap).toEqual(snapshot.header.wrap);
  expect(fresh.getSnapshot().header?.kdf).toEqual(snapshot.header.kdf);
  fresh.lock();
  await reopen(item, ORIGINAL_BYTES);
});

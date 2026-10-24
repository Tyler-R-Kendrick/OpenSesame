/** @vitest-environment jsdom */
/** Held code loading over genuine store ownership and real sealed-export crypto. */
import {
  createItem,
  createVault,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetDeviceIdentityKeyInFlightForTests } from "../device-identity-key.js";
import { kvDelete, kvGet } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { storeImportEntrySeams } from "./store-import-entry.js";
import type { ImportOptions } from "./store-import.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "genuine sealed import source password 49375";
const TARGET_PASSWORD = "genuine sealed import destination password 68245";
const originalLoad = storeImportEntrySeams.load;
const stores: VaultStore[] = [];
const keys: Uint8Array[] = [];
const tasks: Promise<unknown>[] = [];
const releases: (() => void)[] = [];

function deferred() {
  let complete = () => {};
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, release: () => complete() };
}
function track<T>(task: Promise<T>): Promise<T> {
  tasks.push(task.catch(() => undefined));
  return task;
}
function heldAction() {
  const gate = deferred();
  const seen = deferred();
  releases.push(gate.release);
  let entered = 0;
  let observed: string | Uint8Array | undefined;
  let options: ImportOptions | undefined;
  storeImportEntrySeams.load = vi.fn(async () => {
    seen.release();
    await gate.promise;
    const actual = await originalLoad();
    return {
      ...actual,
      importSealedInto: (
        ...args: Parameters<typeof actual.importSealedInto>
      ) => {
        entered += 1;
        observed = args[2];
        options = args[3];
        return actual.importSealedInto(...args);
      },
    };
  });
  return {
    gate,
    seen,
    entered: () => entered,
    secret: () => observed,
    options: () => options,
  };
}
function sealedState() {
  return JSON.stringify([
    kvGet(tombFileKey(PERSONAL_TOMB, HEADER_PATH)),
    kvGet(tombFileKey(PERSONAL_TOMB, BODY_PATH)),
  ]);
}
function wipeDevice() {
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
    "config/device-identity-key",
  ])
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  kvDelete(ATTEMPTS_KEY);
  forgetDeviceIdentityKeyInFlightForTests();
}
async function backup() {
  const created = await createVault(PASSWORD);
  keys.push(created.rawVaultKey);
  const tomb = "sealed-import-source";
  const body = await sealJson(
    created.vaultKey,
    {
      v: 1,
      rev: 0,
      items: [createItem("note", "Held original backup")],
      folders: [],
    },
    vaultSealBinding(tomb, BODY_PATH),
  );
  return {
    text: JSON.stringify({
      format: "opensesame-vault-export",
      v: 1,
      tomb,
      header: created.header,
      body,
    }),
    raw: () => created.rawVaultKey.slice(),
  };
}
async function destination() {
  const store = new VaultStore();
  stores.push(store);
  await store.create(TARGET_PASSWORD);
  await store.flushPendingWrites();
  return store;
}
beforeEach(async () => {
  await vfsFlush();
  wipeDevice();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(tasks.splice(0));
  for (const store of stores.splice(0)) store.lock();
  for (const key of keys.splice(0)) key.fill(0);
  await vfsFlush();
  storeImportEntrySeams.load = originalLoad;
  vi.restoreAllMocks();
});

it("constructs a store and binds its public importer without loading the restore implementation", () => {
  const load = vi.fn(originalLoad);
  storeImportEntrySeams.load = load;
  const store = new VaultStore();
  stores.push(store);
  expect(store.importSealed).toEqual(expect.any(Function));
  expect(load).not.toHaveBeenCalled();
});
it("holds an immutable consuming raw-key request, then genuinely decrypts and persists it", async () => {
  const source = await backup();
  const target = await destination();
  const held = heldAction();
  const raw = source.raw();
  const pending = track(target.importSealed(source.text, raw));
  expect(raw.every((byte) => byte === 0)).toBe(true);
  raw.fill(91);
  await held.seen.promise;
  expect(target.getSnapshot().items).toEqual([]);
  held.gate.release();
  await expect(pending).resolves.toBe(1);
  expect(target.getSnapshot().items.map((item) => item.name)).toEqual([
    "Held original backup",
  ]);
  const consumed = held.secret();
  expect(consumed).toBeInstanceOf(Uint8Array);
  expect(consumed).not.toBe(raw);
  expect(
    consumed instanceof Uint8Array && consumed.every((byte) => byte === 0),
  ).toBe(true);
  await target.flushPendingWrites();
  target.lock();
  const cold = new VaultStore();
  stores.push(cold);
  cold.rehydrate();
  await cold.unlock(TARGET_PASSWORD);
  expect(cold.getSnapshot().items.map((item) => item.name)).toEqual([
    "Held original backup",
  ]);
});
it("captures the person's original restore option before the implementation load", async () => {
  const source = await backup();
  const target = await destination();
  const held = heldAction();
  const options = { adoptIdentity: false };
  const pending = track(
    target.importSealed(source.text, source.raw(), options),
  );
  await held.seen.promise;
  options.adoptIdentity = true;
  held.gate.release();
  await expect(pending).resolves.toBe(1);
  expect(held.options()?.adoptIdentity).toBe(false);
});
it("cannot replace the captured operation check with a permissive callback while loading", async () => {
  const source = await backup();
  const target = await destination();
  const held = heldAction();
  let current = true;
  const options = {
    assertCurrent: () => {
      if (!current) throw new Error("Original restore request ended");
    },
  };
  const before = sealedState();
  const pending = track(
    target.importSealed(source.text, source.raw(), options),
  );
  await held.seen.promise;
  current = false;
  options.assertCurrent = () => {};
  const refused = expect(pending).rejects.toThrow(
    "Original restore request ended",
  );
  held.gate.release();
  await refused;
  expect(held.entered()).toBe(0);
  expect(sealedState()).toBe(before);
  expect(target.getSnapshot().items).toEqual([]);
});
it("denies a held restore after the real destination locks and opens a new session", async () => {
  const source = await backup();
  const target = await destination();
  const held = heldAction();
  const pending = track(target.importSealed(source.text, source.raw()));
  await held.seen.promise;
  target.lock();
  await target.unlock(TARGET_PASSWORD);
  const before = sealedState();
  const refused = expect(pending).rejects.toThrow();
  held.gate.release();
  await refused;
  expect(held.entered()).toBe(0);
  expect(sealedState()).toBe(before);
  expect(target.getSnapshot().items).toEqual([]);
});
it("leaves the vault untouched when the action chunk is unavailable and permits a fresh explicit retry", async () => {
  const source = await backup();
  const target = await destination();
  const before = sealedState();
  storeImportEntrySeams.load = () =>
    Promise.reject(
      new TypeError("Failed to fetch dynamically imported module"),
    );
  const raw = source.raw();
  await expect(target.importSealed(source.text, raw)).rejects.toThrow(
    "Failed to fetch dynamically imported module",
  );
  expect(raw.every((byte) => byte === 0)).toBe(true);
  expect(sealedState()).toBe(before);
  expect(target.getSnapshot().items).toEqual([]);
  storeImportEntrySeams.load = originalLoad;
  await expect(target.importSealed(source.text, source.raw())).resolves.toBe(1);
});
it("clears its owned raw copy even when the actual decrypt/import implementation rejects the file", async () => {
  const source = await backup();
  const target = await destination();
  const before = sealedState();
  const held = heldAction();
  const pending = track(target.importSealed("not valid JSON", source.raw()));
  await held.seen.promise;
  const refused = expect(pending).rejects.toThrow(
    "That file is not valid JSON",
  );
  held.gate.release();
  await refused;
  expect(held.entered()).toBe(1);
  const consumed = held.secret();
  expect(
    consumed instanceof Uint8Array && consumed.every((byte) => byte === 0),
  ).toBe(true);
  expect(sealedState()).toBe(before);
});

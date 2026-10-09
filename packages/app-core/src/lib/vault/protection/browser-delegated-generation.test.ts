/** Completion holds delegate to actual cryptography; no owner or MAC is supplied. */
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
  tombFileKey,
  vfsFlush,
} from "../../vfs.js";
import { ATTEMPTS_KEY, VaultStore } from "../store.js";
import { LEGACY_PREFS_KEY } from "../tomb-migration.js";
import * as manifestAuth from "./manifest-auth.js";

const PASSWORD = "correct horse battery staple";
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);
const stores: VaultStore[] = [];
const roots: Uint8Array[] = [];

function gate() {
  let announce = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, held, announce, release };
}

async function owner() {
  const store = new VaultStore();
  stores.push(store);
  await store.create(PASSWORD);
  await store.protection.ensureProtectionProjected();
  const item = vaultCore.createItem("note", "delegated generation control");
  item.notes = "genuine payload survives refused administration";
  await store.saveItem(item);
  await vfsFlush();
  return { store, item };
}

async function snapshot(store: VaultStore) {
  const header = store.getSnapshot().header;
  if (!header) throw new Error("The genuine owner has no header.");
  const root = await vaultCore.unwrapRawVaultKeyFromPassword(header, PASSWORD);
  roots.push(root);
  return {
    header: kvGet(HEADER_KEY),
    body: kvGet(BODY_KEY),
    root,
  };
}

async function assertUnchanged(
  store: VaultStore,
  before: Awaited<ReturnType<typeof snapshot>>,
) {
  await vfsFlush();
  const after = await snapshot(store);
  try {
    expect(after.header).toBe(before.header);
    expect(after.body).toBe(before.body);
    expect(after.root).toEqual(before.root);
  } finally {
    after.root.fill(0);
  }
}

beforeEach(async () => {
  await vfsFlush();
  kvDelete(ATTEMPTS_KEY);
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  kvDelete(LEGACY_PREFS_KEY);
  writeLastVaultId(PERSONAL_TOMB);
});

afterEach(async () => {
  for (const root of roots.splice(0)) root.fill(0);
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.lock();
  await vfsFlush();
});

it("refuses an old preferred-protector operation after its genuine MAC completes in a fresh owner generation", async () => {
  const { store, item } = await owner();
  const record = store.protection
    .listProtectors()
    .find((entry) => entry.kind === "password");
  if (!record) throw new Error("The genuine owner has no password protector.");
  const before = await snapshot(store);
  const delivery = gate();
  const actualSeal = manifestAuth.sealAuthenticatedManifest;
  let once = true;
  const observe = vi
    .spyOn(manifestAuth, "sealAuthenticatedManifest")
    .mockImplementation(async (...args) => {
      const pause = once;
      once = false;
      const sealed = await actualSeal(...args);
      if (pause) {
        delivery.announce();
        await delivery.held;
      }
      return sealed;
    });
  const pending = store.protection.setPreferred(record.protectorId);
  const refusal = expect(pending).rejects.toMatchObject({
    code: "stale_operation",
  });
  try {
    await delivery.entered;
    store.lock();
    await store.unlock(PASSWORD);
    delivery.release();
    await refusal;
    await assertUnchanged(store, before);
    await store.protection.setPreferred(record.protectorId);
    expect(store.getSnapshot().header?.protection?.preferredProtectorId).toBe(
      record.protectorId,
    );
    store.lock();
    await store.unlock(PASSWORD);
    expect(
      store.getSnapshot().items.find((entry) => entry.id === item.id)?.notes,
    ).toBe(item.notes);
  } finally {
    delivery.release();
    await refusal.catch(() => undefined);
    observe.mockRestore();
    before.root.fill(0);
  }
});

it("refuses an old rotation after its genuine password wrap completes in a fresh owner generation", async () => {
  const { store, item } = await owner();
  const before = await snapshot(store);
  const delivery = gate();
  const actualWrap = vaultCore.wrapVaultKeyWithPassword;
  let once = true;
  const observe = vi
    .spyOn(vaultCore, "wrapVaultKeyWithPassword")
    .mockImplementation(async (...args) => {
      const pause = once;
      once = false;
      const wrapped = await actualWrap(...args);
      if (pause) {
        delivery.announce();
        await delivery.held;
      }
      return wrapped;
    });
  const pending = store.protection.rotateCompromisedRoot({
    password: PASSWORD,
  });
  const refusal = expect(pending).rejects.toMatchObject({
    code: "stale_operation",
  });
  try {
    await delivery.entered;
    store.lock();
    await store.unlock(PASSWORD);
    delivery.release();
    await refusal;
    await assertUnchanged(store, before);
    const epoch = store.getSnapshot().header?.protection?.rootEpoch;
    if (epoch === undefined)
      throw new Error("The genuine owner has no root epoch.");
    await store.protection.rotateCompromisedRoot({ password: PASSWORD });
    expect(store.getSnapshot().header?.protection?.rootEpoch).toBe(epoch + 1);
    store.lock();
    await store.unlock(PASSWORD);
    expect(
      store.getSnapshot().items.find((entry) => entry.id === item.id)?.notes,
    ).toBe(item.notes);
  } finally {
    delivery.release();
    await refusal.catch(() => undefined);
    observe.mockRestore();
    before.root.fill(0);
  }
});

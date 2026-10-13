/** Genuine projection crypto completion holds; no owner or MAC verdict is supplied. */
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
  tombFileKey,
  vfsFlush,
} from "../../vfs.js";
import { ATTEMPTS_KEY, VaultStore } from "../store.js";
import { LEGACY_PREFS_KEY } from "../tomb-migration.js";
import * as manifestAuth from "./manifest-auth.js";

const PASSWORD = "correct horse battery staple";
const NEXT_PASSWORD = "a different horse with a new battery";
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);
const stores: VaultStore[] = [];
const operations: Promise<void>[] = [];
const releases: (() => void)[] = [];

function track(operation: Promise<void>): Promise<void> {
  operations.push(operation);
  return operation;
}

function holdFirstSealCompletion() {
  let announce = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  const actualSeal = manifestAuth.sealAuthenticatedManifest;
  let once = true;
  const observe = vi
    .spyOn(manifestAuth, "sealAuthenticatedManifest")
    .mockImplementation(async (...args) => {
      const pause = once;
      once = false;
      const sealed = await actualSeal(...args);
      if (pause) {
        announce();
        await held;
      }
      return sealed;
    });
  return { entered, release, observe };
}

function physical() {
  const header = kvGet(HEADER_KEY);
  const body = kvGet(BODY_KEY);
  if (header === null || body === null)
    throw new Error("The genuine vault is missing its stored header or BODY.");
  return { header, body };
}

async function unprojectedOwner() {
  const store = new VaultStore();
  stores.push(store);
  await store.create(PASSWORD);
  expect(store.getSnapshot().header?.protection).toBeUndefined();
  const item = vaultCore.createItem("note", "projection continuity payload");
  item.notes = "retained across a refused stale header projection";
  await store.saveItem(item);
  await vfsFlush();
  return { store, item };
}

async function reopen(password: string, item: vaultCore.VaultItem) {
  const fresh = new VaultStore();
  stores.push(fresh);
  await fresh.unlock(password);
  expect(fresh.getSnapshot().status).toBe("unlocked");
  expect(
    fresh.getSnapshot().items.find((entry) => entry.id === item.id)?.notes,
  ).toBe(item.notes);
  return fresh;
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
  for (const store of stores.splice(0)) store.lock();
  await vfsFlush();
});

it("refuses a delayed genuine projection after a same-Store password change, preserving the new password and stored BODY", async () => {
  const { store, item } = await unprojectedOwner();
  const before = physical();
  const delivery = holdFirstSealCompletion();
  const pending = track(store.protection.ensureProtectionProjected());
  const refusal = expect(pending).rejects.toMatchObject({
    code: "stale_operation",
  });
  try {
    await delivery.entered;
    await store.changeMasterPassword(PASSWORD, NEXT_PASSWORD);
    await vfsFlush();
    const changed = physical();
    expect(changed.header).not.toBe(before.header);
    delivery.release();
    await refusal;
    await vfsFlush();
    expect(physical()).toEqual(changed);
    delivery.observe.mockRestore();
    store.lock();
    await reopen(NEXT_PASSWORD, item);
  } finally {
    delivery.release();
    await refusal.catch(() => undefined);
  }
});

it("allows two queued genuine projections and preserves their authenticated idempotent header and real payload", async () => {
  const { store, item } = await unprojectedOwner();
  const delivery = holdFirstSealCompletion();
  const first = track(store.protection.ensureProtectionProjected());
  await delivery.entered;
  const second = track(store.protection.ensureProtectionProjected());
  try {
    delivery.release();
    await first;
    const projected = physical();
    await second;
    await vfsFlush();
    expect(physical()).toEqual(projected);
    const header = store.getSnapshot().header;
    if (!header?.protection)
      throw new Error("The genuine projected manifest is missing.");
    const root = await vaultCore.unwrapRawVaultKeyFromPassword(
      header,
      PASSWORD,
    );
    try {
      await expect(
        manifestAuth.verifyManifestAuth(root, header.protection),
      ).resolves.toBeUndefined();
    } finally {
      root.fill(0);
    }
    delivery.observe.mockRestore();
    store.lock();
    await reopen(PASSWORD, item);
  } finally {
    delivery.release();
    await Promise.allSettled([first, second]);
  }
});

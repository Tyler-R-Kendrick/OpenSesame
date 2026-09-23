/**
 * A body the header says was written may not quietly become an empty vault:
 * missing and older bodies are both refused before the vault opens.
 */

import { createItem, createVault } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { VaultCorruptError, VaultStore, readTombHeader } from "./store.js";

const PASSWORD = "correct horse battery staple";
const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);
const BODY_KEY = tombFileKey(PERSONAL_TOMB, BODY_PATH);

async function storeWithOneWrite(): Promise<VaultStore> {
  const { header } = await createVault(PASSWORD);
  kvSet(HEADER_KEY, JSON.stringify(header));
  const store = new VaultStore();
  await store.unlock(PASSWORD);
  await store.saveItem(createItem("login", "Written"));
  await store.flushPendingWrites();
  await vfsFlush();
  store.lock();
  return store;
}

beforeEach(() => {
  kvDelete(HEADER_KEY);
  kvDelete(BODY_KEY);
});

describe("VaultStore body rollback witness", () => {
  it("refuses to open when the body is missing but the header records a write", async () => {
    const store = await storeWithOneWrite();
    expect(readTombHeader(PERSONAL_TOMB)?.bodyRev).toBeGreaterThan(0);
    kvDelete(BODY_KEY);
    await expect(store.unlock(PASSWORD)).rejects.toBeInstanceOf(
      VaultCorruptError,
    );
    expect(store.getSnapshot().status).toBe("locked");
  });

  it("still opens a vault that has never written a body as empty", async () => {
    const { header } = await createVault(PASSWORD);
    kvSet(HEADER_KEY, JSON.stringify(header));
    const store = new VaultStore();
    await store.unlock(PASSWORD);
    expect(store.getSnapshot().status).toBe("unlocked");
    expect(store.getSnapshot().items).toHaveLength(0);
    expect(kvGet(BODY_KEY)).toBeNull();
  });
});

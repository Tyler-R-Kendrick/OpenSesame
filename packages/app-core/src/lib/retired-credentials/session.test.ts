import { createItem } from "@opensesame/vault-core";
import { afterEach, expect, it } from "vitest";
import {
  clearActivePresentation,
  readActivePresentation,
} from "../duress/compartment/presentation-runtime.js";
import { duressSessionFence } from "../duress/session/fence.js";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import { VaultStore } from "../vault/store.js";
import { BODY_PATH, GUEST_TOMB, HEADER_PATH, tombFileKey } from "../vfs.js";
import { openRetiredCredentialDecoy } from "./session.js";

let store: VaultStore | null = null;
afterEach(() => {
  store?.lock();
  clearActivePresentation();
});

it("preserves an unsealed guest's files when entering a retired-password decoy", async () => {
  const headerKey = tombFileKey(GUEST_TOMB, HEADER_PATH);
  const bodyKey = tombFileKey(GUEST_TOMB, BODY_PATH);
  const previousHeader = kvGet(headerKey);
  const previousBody = kvGet(bodyKey);
  const guestHeader = JSON.stringify({
    v: 1,
    createdAt: new Date().toISOString(),
  });
  const guestBody = "existing encrypted guest body";
  kvSet(headerKey, guestHeader);
  kvSet(bodyKey, guestBody);
  store = new VaultStore();
  try {
    await openRetiredCredentialDecoy(
      store,
      {
        id: "selected",
        createdAt: new Date().toISOString(),
        response: "synthetic_decoy",
      },
      "personal",
    );
    await store.saveItem(createItem("note", "Synthetic change"));
    await store.flushPendingWrites();
    expect(kvGet(headerKey)).toBe(guestHeader);
    expect(kvGet(bodyKey)).toBe(guestBody);
    store.lock();
    expect(kvGet(headerKey)).toBe(guestHeader);
    expect(kvGet(bodyKey)).toBe(guestBody);
  } finally {
    if (previousHeader === null) kvDelete(headerKey);
    else kvSet(headerKey, previousHeader);
    if (previousBody === null) kvDelete(bodyKey);
    else kvSet(bodyKey, previousBody);
  }
});

it("renders ordinary synthetic items without owner data and returns to sealed owner authentication", async () => {
  store = new VaultStore();
  await store.createWithPin("93746281");
  const owner = createItem("note", "Owner private note");
  owner.notes = "owner-only-secret";
  await store.saveItem(owner);
  store.lock();
  const before = duressSessionFence.readFence();
  await openRetiredCredentialDecoy(
    store,
    {
      id: "selected",
      createdAt: new Date().toISOString(),
      response: "synthetic_decoy",
    },
    "personal",
  );
  const state = store.getSnapshot();
  expect(state.status).toBe("unlocked");
  expect(state.decoy).toBe(true);
  expect(state.items).toHaveLength(1);
  expect(state.items[0]?.kind).toBe("account");
  expect(JSON.stringify(state.items)).not.toContain("owner-only-secret");
  expect(JSON.stringify(state.items)).not.toContain(owner.id);
  expect(readActivePresentation()?.storeOwnsView).toBe(true);
  expect(duressSessionFence.readFence()).toEqual(before);
  await expect(store.unlockWithPin("93746281")).rejects.toThrow(
    "authenticate again",
  );
  store.lock();
  expect(store.getSnapshot().status).toBe("locked");
  await store.unlockWithPin("93746281");
  expect(store.getSnapshot().items).toContainEqual(
    expect.objectContaining({ id: owner.id, notes: "owner-only-secret" }),
  );
  expect(store.getSnapshot().decoy).toBe(false);
});

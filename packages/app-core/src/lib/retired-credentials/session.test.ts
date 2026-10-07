import {
  createItem,
  isCredential,
  outsideAccounts,
} from "@opensesame/vault-core";
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
  const accounts = outsideAccounts(state.items);
  expect(accounts).toHaveLength(1);
  const account = accounts[0];
  expect(account?.kind).toBe("account");
  const credentials = state.rawItems?.filter(isCredential) ?? [];
  expect(credentials).toHaveLength(1);
  expect(credentials[0]?.accountId).toBe(account?.id);
  expect(credentials[0]?.method.type).toBe("password");
  expect(JSON.stringify(credentials[0]?.method)).toContain("synthetic-");
  const rawAccount = state.rawItems?.find((item) => item.id === account?.id);
  expect(rawAccount?.kind === "account" && rawAccount.methods).toEqual([]);
  expect(JSON.stringify(state.rawItems)).not.toContain("owner-only-secret");
  expect(JSON.stringify(state.rawItems)).not.toContain(owner.id);
  expect(JSON.stringify(state.items)).not.toContain("owner-only-secret");
  expect(JSON.stringify(state.items)).not.toContain(owner.id);
  expect(readActivePresentation()?.storeOwnsView).toBe(true);
  expect(duressSessionFence.readFence()).toEqual(before);
  await expect(store.unlockWithPin("93746281")).rejects.toThrow(
    "authenticate again",
  );
  store.lock();
  expect(store.getSnapshot().status).toBe("locked");
  expect(store.getSnapshot().rawItems).toEqual([]);
  await store.unlockWithPin("93746281");
  expect(store.getSnapshot().items).toContainEqual(
    expect.objectContaining({ id: owner.id, notes: "owner-only-secret" }),
  );
  expect(store.getSnapshot().decoy).toBe(false);
});

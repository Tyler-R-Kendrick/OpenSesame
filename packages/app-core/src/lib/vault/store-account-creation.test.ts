import {
  type AccountItem,
  type VaultBody,
  importVaultKey,
  itemTypeId,
  openJson,
  passwordMethod,
  produceAccountPassword,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { typePassword } from "../account.test-support.js";
import { kvDelete, kvSeams } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  readSealedFile,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { newItemDraft } from "./new-draft.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";
const stores: VaultStore[] = [];

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
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores) {
    await store.flushPendingWrites();
    store.lock();
  }
  stores.length = 0;
});

async function openStore(): Promise<VaultStore> {
  const store = new VaultStore();
  stores.push(store);
  await store.create(PASSWORD);
  return store;
}

function accountDraft(name: string): AccountItem {
  const item = newItemDraft("account", name);
  if (item.kind !== "account") throw new Error("Not an account draft");
  return item;
}

async function sealedBody(store: VaultStore): Promise<VaultBody> {
  await store.flushPendingWrites();
  await vfsFlush();
  const header = store.getSnapshot().header;
  const sealed = readSealedFile(PERSONAL_TOMB, BODY_PATH);
  if (!header || !sealed) throw new Error("No sealed vault body");
  const key = await importVaultKey(
    await unwrapRawVaultKeyFromPassword(header, PASSWORD),
  );
  return openJson<VaultBody>(
    key,
    sealed,
    vaultSealBinding(PERSONAL_TOMB, BODY_PATH),
  );
}

describe("creating an account through the application draft", () => {
  it.each(["generated", "entered"] as const)(
    "keeps the %s password as one bound password item through a lock and unlock",
    async (source) => {
      const store = await openStore();
      const account = accountDraft("Billing");
      const method = passwordMethod(account);
      if (!method) throw new Error("Draft has no password");
      if (source === "entered") typePassword(method, "person-entered-password");
      const produced = produceAccountPassword(account);
      expect(produced).toMatchObject(
        source === "generated"
          ? { status: "slotted", head: expect.stringMatching(/^.{20}$/) }
          : { status: "ok", password: "person-entered-password" },
      );

      await store.saveItem(account);
      const raw = store.getSnapshot().rawItems;
      expect(raw).toHaveLength(2);
      expect(raw?.find((item) => item.id === account.id)).toMatchObject({
        kind: "account",
        methods: [],
      });
      const credential = raw?.find((item) => item.kind === "credential");
      expect(credential).toMatchObject({
        id: method.id,
        kind: "credential",
        accountId: account.id,
        method,
      });
      if (!credential) throw new Error("Password item was not created");
      expect(itemTypeId(credential)).toBe("password");
      expect((await sealedBody(store)).items).toEqual(raw);

      store.lock();
      expect(store.getSnapshot().items).toEqual([]);
      await store.unlock(PASSWORD);
      expect(store.getSnapshot().rawItems).toEqual(raw);
      const reopened = store
        .getSnapshot()
        .items.find((item) => item.id === account.id);
      if (reopened?.kind !== "account")
        throw new Error("Account did not reopen");
      expect(reopened.methods).toEqual([method]);
      expect(produceAccountPassword(reopened)).toEqual(produced);
    },
  );

  it("creates only the account when its draft password is removed", async () => {
    const store = await openStore();
    const account = accountDraft("Passwordless");
    account.methods = [];
    await store.saveItem(account);
    expect(store.getSnapshot().rawItems).toEqual([
      expect.objectContaining({ id: account.id, kind: "account", methods: [] }),
    ]);
    store.lock();
    await store.unlock(PASSWORD);
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(store.getSnapshot().items[0]).toMatchObject({
      id: account.id,
      kind: "account",
      methods: [],
    });
  });

  it("leaves neither an account nor an orphan password after a refused sealed write", async () => {
    const store = await openStore();
    const kept = accountDraft("Kept");
    await store.saveItem(kept);
    const previous = store.getSnapshot().rawItems;
    const before = await sealedBody(store);
    const lost = accountDraft("Lost");
    const failure = vi
      .spyOn(kvSeams, "kvSetDurable")
      .mockRejectedValue(new Error("storage refused the write"));
    await expect(store.saveItem(lost)).rejects.toThrow(
      "storage refused the write",
    );
    failure.mockRestore();

    expect(store.getSnapshot().rawItems).toEqual(previous);
    expect((await sealedBody(store)).items).toEqual(before.items);
    store.lock();
    await store.unlock(PASSWORD);
    expect(store.getSnapshot().rawItems).toEqual(previous);

    // Retrying creates both entries once, rather than leaving a stray credential.
    await store.saveItem(lost);
    const raw = store.getSnapshot().rawItems ?? [];
    expect(raw).toHaveLength(4);
    expect(raw.filter((item) => item.id === lost.id)).toHaveLength(1);
    expect(
      raw.filter(
        (item) => item.kind === "credential" && item.accountId === lost.id,
      ),
    ).toHaveLength(1);
  });
});

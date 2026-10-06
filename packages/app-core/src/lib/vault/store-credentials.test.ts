/**
 * Credentials are entries of their own (ADR 0179), through a real store: an
 * account saved with methods keeps each as a credential bound to it, the
 * credential follows its account into the trash and out of it, a credential
 * kept on its own binds and unbinds, and nothing a person removed comes back
 * or is lost by an edit made somewhere else.
 */
import {
  type AccountItem,
  type CredentialItem,
  type LoginMethod,
  type VaultBody,
  boundCredentials,
  createCredential,
  createItem,
  importVaultKey,
  manualPassword,
  openJson,
  outsideAccounts,
  resolveAccounts,
  unboundCredentials,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "../kv.js";
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
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";

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

async function openStore(): Promise<VaultStore> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  return store;
}

const apiKey = (id: string, header = "X-Api-Key"): LoginMethod => ({
  id,
  type: "api-key",
  key: `key-${id}`,
  header,
});

function accountWith(name: string, ...extra: LoginMethod[]): AccountItem {
  const account = createItem("account", name);
  return { ...account, methods: [...account.methods, ...extra] };
}

function accountIn(store: VaultStore, id: string): AccountItem {
  const found = store.getSnapshot().items.find((item) => item.id === id);
  if (found?.kind !== "account") throw new Error(`no account ${id}`);
  return found;
}

function credentials(store: VaultStore): CredentialItem[] {
  return store
    .getSnapshot()
    .items.filter((item): item is CredentialItem => item.kind === "credential");
}

async function sealedBody(store: VaultStore): Promise<VaultBody> {
  await store.flushPendingWrites();
  await vfsFlush();
  const header = store.getSnapshot().header;
  const sealed = readSealedFile(PERSONAL_TOMB, BODY_PATH);
  if (!header || !sealed) throw new Error("nothing was written");
  const key = await importVaultKey(
    await unwrapRawVaultKeyFromPassword(header, PASSWORD),
  );
  return openJson<VaultBody>(
    key,
    sealed,
    vaultSealBinding(PERSONAL_TOMB, BODY_PATH),
  );
}

describe("an account's credentials are entries of their own", () => {
  it("keeps each method as a credential, and the sealed account holds none", async () => {
    const store = await openStore();
    const account = accountWith("Billing", apiKey("k1"));
    await store.saveItem(account);

    expect(accountIn(store, account.id).methods.map((m) => m.type)).toEqual([
      "password",
      "api-key",
    ]);
    expect(credentials(store).map((c) => c.name)).toEqual([
      "Billing · Password",
      "Billing · API key",
    ]);
    expect(outsideAccounts(store.getSnapshot().items)).toHaveLength(1);

    const body = await sealedBody(store);
    const sealed = body.items.find((item) => item.id === account.id);
    expect(sealed?.kind === "account" && sealed.methods).toEqual([]);
    expect(
      body.items.filter((item) => item.kind === "credential"),
    ).toHaveLength(2);
    store.lock();
  });

  it("survives a lock and an unlock, in order", async () => {
    const store = await openStore();
    const account = accountWith("Billing", apiKey("k1"));
    await store.saveItem(account);
    await store.flushPendingWrites();
    store.lock();
    await store.unlock(PASSWORD);
    expect(
      accountIn(store, account.id).methods.map((method) => method.id),
    ).toEqual(account.methods.map((method) => method.id));
    store.lock();
  });

  it("moves a removed method to the trash, where it can be restored", async () => {
    const store = await openStore();
    const account = accountWith("Billing", apiKey("k1"));
    await store.saveItem(account);

    const held = accountIn(store, account.id);
    await store.saveItem({
      ...held,
      methods: held.methods.filter((method) => method.id !== "k1"),
    });
    expect(accountIn(store, account.id).methods.map((m) => m.type)).toEqual([
      "password",
    ]);
    const gone = credentials(store).find((c) => c.id === "k1");
    expect(gone?.deletedAt).not.toBeNull();
    expect(gone?.accountId).toBe(account.id);

    await store.restoreItem("k1");
    expect(accountIn(store, account.id).methods.map((m) => m.type)).toEqual([
      "password",
      "api-key",
    ]);
    store.lock();
  });

  it("follows its account into the trash and out, but not one removed before", async () => {
    const store = await openStore();
    const account = accountWith("Billing", apiKey("k1"), apiKey("k2", "X-B"));
    await store.saveItem(account);
    await store.trashItem("k2");
    await store.trashItem(account.id);
    expect(credentials(store).every((c) => c.deletedAt !== null)).toBe(true);

    await store.restoreItem(account.id);
    expect(
      credentials(store)
        .filter((c) => c.deletedAt === null)
        .map((c) => c.id)
        .sort(),
    ).toEqual([account.methods[0]?.id, "k1"].sort());
    expect(credentials(store).find((c) => c.id === "k2")?.deletedAt).not.toBe(
      null,
    );
    store.lock();
  });

  it("is purged with its account, and a purge that reaches another device cannot bring it back", async () => {
    const store = await openStore();
    const account = accountWith("Billing", apiKey("k1"));
    await store.saveItem(account);
    await store.trashItem(account.id);
    await store.purgeItem(account.id);
    expect(store.getSnapshot().items).toEqual([]);
    const body = await sealedBody(store);
    expect(Object.keys(body.tombstones?.items ?? {}).sort()).toEqual(
      [account.id, "k1", account.methods[0]?.id].sort(),
    );
    store.lock();
  });

  it("empties the trash of a trashed account and its credentials together", async () => {
    const store = await openStore();
    const account = accountWith("Billing", apiKey("k1"));
    await store.saveItem(account);
    await store.trashItem(account.id);
    await store.emptyTrash();
    expect(store.getSnapshot().items).toEqual([]);
    store.lock();
  });

  it("follows the account's name, and keeps a name a person gave", async () => {
    const store = await openStore();
    const account = accountWith("Billing", apiKey("k1"));
    await store.saveItem(account);
    const key = credentials(store).find((c) => c.id === "k1");
    if (!key) throw new Error("fixture");
    await store.saveItem({ ...key, name: "Prod key" });

    const held = accountIn(store, account.id);
    await store.saveItem({ ...held, name: "Invoicing" });
    const byId = new Map(credentials(store).map((c) => [c.id, c]));
    expect(byId.get("k1")?.name).toBe("Prod key");
    expect(byId.get(account.methods[0]?.id ?? "")?.name).toBe(
      "Invoicing · Password",
    );
    store.lock();
  });

  it("leaves another account's credential alone when a method carries its id", async () => {
    const store = await openStore();
    const first = accountWith("First", apiKey("shared"));
    await store.saveItem(first);
    const second = accountWith("Second", apiKey("shared", "X-Other"));
    await store.saveItem(second);

    expect(boundCredentials(store.getSnapshot().items, first.id)).toHaveLength(
      2,
    );
    const ids = credentials(store).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const owner = credentials(store).find((c) => c.id === "shared");
    expect(owner?.accountId).toBe(first.id);
    expect(accountIn(store, second.id).methods.map((m) => m.type)).toContain(
      "api-key",
    );
    store.lock();
  });

  it("does not overwrite a note whose id a method names", async () => {
    const store = await openStore();
    const note = createItem("note", "A note");
    await store.saveItem(note);
    await store.saveItem(accountWith("Billing", apiKey(note.id)));
    expect(
      store.getSnapshot().items.find((item) => item.id === note.id)?.kind,
    ).toBe("note");
    expect(
      credentials(store).filter((c) => c.method.type === "api-key"),
    ).toHaveLength(1);
    store.lock();
  });
});

describe("a credential kept on its own", () => {
  it("is saved, listed and unbound", async () => {
    const store = await openStore();
    const own = createCredential(
      manualPassword("p1", "pw-1", new Date().toISOString()),
      "Generated",
    );
    await store.saveItem(own);
    expect(unboundCredentials(store.getSnapshot().items)).toHaveLength(1);
    expect(store.getSnapshot().items[0]).toMatchObject({
      kind: "credential",
      accountId: null,
      name: "Generated",
    });
    store.lock();
  });

  it("binds to an account and becomes one of its methods, named after it", async () => {
    const store = await openStore();
    const account = accountWith("Billing");
    await store.saveItem(account);
    const own = createCredential(apiKey("k9"), "Spare", null);
    await store.saveItem(own);

    await store.saveItem({ ...own, accountId: account.id });
    expect(accountIn(store, account.id).methods.map((m) => m.id)).toContain(
      "k9",
    );
    expect(credentials(store).find((c) => c.id === "k9")?.name).toBe(
      "Billing · API key",
    );
    store.lock();
  });

  it("keeps a name its person gave when it binds", async () => {
    const store = await openStore();
    const account = accountWith("Billing");
    await store.saveItem(account);
    await store.saveItem(
      createCredential(apiKey("k9"), "Prod key", account.id),
    );
    expect(credentials(store).find((c) => c.id === "k9")?.name).toBe(
      "Prod key",
    );
    store.lock();
  });

  it("unbinds without losing a value, and the account no longer lists it", async () => {
    const store = await openStore();
    const account = accountWith("Billing", apiKey("k1"));
    await store.saveItem(account);
    const key = credentials(store).find((c) => c.id === "k1");
    if (!key) throw new Error("fixture");
    await store.saveItem({ ...key, accountId: null });

    expect(accountIn(store, account.id).methods.map((m) => m.id)).not.toContain(
      "k1",
    );
    const freed = unboundCredentials(store.getSnapshot().items);
    expect(freed.map((c) => c.id)).toEqual(["k1"]);
    expect(freed[0]?.method).toMatchObject({ key: "key-k1" });
    store.lock();
  });

  it("will not bind to an account that is not there or is in the trash", async () => {
    const store = await openStore();
    const account = accountWith("Billing");
    await store.saveItem(account);
    const own = createCredential(apiKey("k9"), "Spare", null);
    await store.saveItem(own);
    await expect(store.saveItem({ ...own, accountId: "nope" })).rejects.toThrow(
      "no longer there",
    );
    await store.trashItem(account.id);
    await expect(
      store.saveItem({ ...own, accountId: account.id }),
    ).rejects.toThrow("no longer there");
    expect(credentials(store).find((c) => c.id === "k9")?.accountId).toBeNull();
    store.lock();
  });

  it("reads as unbound when its account is purged, without rewriting anything", async () => {
    const store = await openStore();
    const account = accountWith("Billing", apiKey("k1"));
    await store.saveItem(account);
    await store.trashItem(account.id);
    await store.restoreItem("k1");
    // k1 is back while its account is still in the trash: nothing opens with it.
    expect(
      unboundCredentials(store.getSnapshot().items).map((c) => c.id),
    ).toEqual(["k1"]);
    store.lock();
  });
});

describe("what a surface reads", () => {
  it("resolves accounts on the snapshot and nowhere else", async () => {
    const store = await openStore();
    const account = accountWith("Billing", apiKey("k1"));
    await store.saveItem(account);
    expect(
      (store.getSnapshot().rawItems ?? []).find(
        (item) => item.id === account.id,
      ),
    ).toMatchObject({ methods: [] });
    expect(
      resolveAccounts(store.getSnapshot().rawItems ?? []).find(
        (item) => item.id === account.id,
      ),
    ).toMatchObject({ methods: expect.any(Array) });
    store.lock();
  });
});

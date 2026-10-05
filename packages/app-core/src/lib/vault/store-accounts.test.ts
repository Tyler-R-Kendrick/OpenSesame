/**
 * A real vault store reading and writing accounts (ADR 0166 §1): a body a
 * pre-account device left on disk, a drive snapshot from a device that has not
 * moved to accounts, and the byte-for-byte survival of a peppered password and
 * a Sphinx key through the store's own seal, merge and export.
 */
import { overlapCast } from "@opensesame/os-domain";
import {
  type AccountItem,
  type VaultBody,
  type VaultHeader,
  createItem,
  importVaultKey,
  openJson,
  passwordMethod,
  pepperBinding,
  sealJson,
  sealWithPepper,
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
  lockTomb,
  readSealedFile,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  writeSealedFile,
} from "../vfs.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const SPHINX_KEY = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";

async function clearVault(): Promise<void> {
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
}

beforeEach(clearVault);

/** A body as a pre-ADR-0166 device wrote it: a `login` item inside. */
function legacyBody(
  rev: number,
  updatedAt = T0,
  password = "hunter2",
): VaultBody {
  const login = {
    id: "login-1",
    kind: "login",
    name: "Mail",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: T0,
    updatedAt,
    deletedAt: null,
    username: "ada",
    password,
    totp: "JBSWY3DPEHPK3PXP",
    uris: [],
    passwordChangedAt: T0,
  };
  return { v: 1, folders: [], items: [overlapCast(login)], rev };
}

async function keyOf(header: VaultHeader): Promise<CryptoKey> {
  return importVaultKey(await unwrapRawVaultKeyFromPassword(header, PASSWORD));
}

async function unlockedWithLegacyBody(): Promise<VaultStore> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  const header = store.getSnapshot().header;
  if (!header) throw new Error("expected a header");
  await store.flushPendingWrites();
  store.lock();
  // Leave a legacy body where the next unlock will find it.
  const key = await keyOf(header);
  unlockTomb(PERSONAL_TOMB, key);
  await writeSealedFile(
    PERSONAL_TOMB,
    BODY_PATH,
    await sealJson(
      key,
      legacyBody(1),
      vaultSealBinding(PERSONAL_TOMB, BODY_PATH),
    ),
  );
  await vfsFlush();
  lockTomb(PERSONAL_TOMB);
  await store.unlock(PASSWORD);
  return store;
}

async function bodyOnDisk(key: CryptoKey): Promise<string> {
  const sealed = readSealedFile(PERSONAL_TOMB, BODY_PATH);
  if (!sealed) throw new Error("no body on disk");
  const body = await openJson<VaultBody>(
    key,
    sealed,
    vaultSealBinding(PERSONAL_TOMB, BODY_PATH),
  );
  return JSON.stringify(body);
}

function accountIn(store: VaultStore, id: string): AccountItem {
  const item = store
    .getSnapshot()
    .items.find((candidate) => candidate.id === id);
  if (item?.kind !== "account") throw new Error(`no account ${id}`);
  return item;
}

describe("a vault body written before accounts", () => {
  it("opens as accounts and is sealed as accounts on the next write", async () => {
    const store = await unlockedWithLegacyBody();
    const header = store.getSnapshot().header;
    if (!header) throw new Error("expected a header");
    const account = accountIn(store, "login-1");
    expect(passwordMethod(account)?.secret).toBe("hunter2");
    expect(store.getSnapshot().items.map((item) => item.kind)).toEqual([
      "account",
    ]);

    // Any write seals the whole body; none of it says `login`.
    await store.saveItem(createItem("note", "Later"));
    await store.flushPendingWrites();
    const sealed = await bodyOnDisk(await keyOf(header));
    expect(sealed).not.toContain('"kind":"login"');
    expect(sealed).toContain('"kind":"account"');
    store.lock();
  });

  it("opens the same account every time it is read", async () => {
    const store = await unlockedWithLegacyBody();
    const first = accountIn(store, "login-1");
    store.lock();
    await store.unlock(PASSWORD);
    expect(accountIn(store, "login-1")).toEqual(first);
    store.lock();
  });

  it("merges a drive snapshot that still holds the login, newer copy winning", async () => {
    const store = await unlockedWithLegacyBody();
    const header = store.getSnapshot().header;
    if (!header) throw new Error("expected a header");
    const key = await keyOf(header);
    const local = accountIn(store, "login-1");
    await store.saveItem({ ...local, username: "local-edit" });

    // An older legacy copy does not undo it.
    const stale = await sealJson(
      key,
      legacyBody(5, T0, "older"),
      vaultSealBinding(PERSONAL_TOMB, BODY_PATH),
    );
    await store.mergeSnapshot({
      tomb: PERSONAL_TOMB,
      createdAt: header.createdAt,
      body: stale,
      rev: 5,
    });
    expect(accountIn(store, "login-1").username).toBe("local-edit");

    // A newer one does, and still leaves one account with one set of methods.
    const fresh = await sealJson(
      key,
      legacyBody(6, "2999-01-01T00:00:00.000Z", "newer"),
      vaultSealBinding(PERSONAL_TOMB, BODY_PATH),
    );
    await store.mergeSnapshot({
      tomb: PERSONAL_TOMB,
      createdAt: header.createdAt,
      body: fresh,
      rev: 6,
    });
    const merged = accountIn(store, "login-1");
    expect(passwordMethod(merged)?.secret).toBe("newer");
    expect(merged.methods.map((method) => method.id)).toEqual([
      "login-1:password",
      "login-1:authenticator",
    ]);
    expect(store.getSnapshot().items).toHaveLength(1);
    store.lock();
  });
});

describe("a pepper seal and a Sphinx key through the store", () => {
  it("survive the seal, a merge and the export untouched", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    const header = store.getSnapshot().header;
    if (!header) throw new Error("expected a header");
    const account = createItem("account", "Peppered");
    const sealed = await sealWithPepper(
      "peppered-pw",
      "the pepper",
      pepperBinding(account.id, `${account.id}:password`),
    );
    const rules = {
      length: 20,
      lower: true,
      upper: true,
      digits: true,
      symbols: true,
      avoidAmbiguous: false,
      minDigits: 0,
      minSymbols: 0,
    };
    account.methods = [
      {
        id: `${account.id}:password`,
        type: "password",
        generator: { id: "manual" },
        pepper: true,
        secret: "",
        sealed,
        changedAt: T0,
      },
      {
        id: `${account.id}:sphinx`,
        type: "password",
        generator: {
          id: "sphinx",
          rules,
          realm: "example.com",
          counter: 1,
          oprfKeyB64: SPHINX_KEY,
        },
        pepper: true,
        secret: "",
        changedAt: T0,
      },
    ];
    const methodsJson = JSON.stringify(account.methods);
    await store.saveItem(account);
    await store.flushPendingWrites();

    // A snapshot from another device that holds only a legacy login.
    const key = await keyOf(header);
    await store.mergeSnapshot({
      tomb: PERSONAL_TOMB,
      createdAt: header.createdAt,
      body: await sealJson(
        key,
        legacyBody(9, T1),
        vaultSealBinding(PERSONAL_TOMB, BODY_PATH),
      ),
      rev: 9,
    });
    await store.flushPendingWrites();

    const held = accountIn(store, account.id);
    expect(JSON.stringify(held.methods)).toBe(methodsJson);
    const onDisk = JSON.parse(await bodyOnDisk(key)) as VaultBody;
    const written = onDisk.items.find((item) => item.id === account.id);
    expect(JSON.stringify(written?.kind === "account" && written.methods)).toBe(
      methodsJson,
    );
    store.lock();
  });
});

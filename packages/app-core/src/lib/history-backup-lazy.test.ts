import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import { createHistoryStore } from "./encrypted-db/history-store.js";
import { createPasswordDigestStore } from "./encrypted-db/password-store.js";
import {
  installHistoryRowStore,
  listHistoryAccounts,
  putHistoryAccount,
  resetHistoryBackupMemory,
} from "./history-backup-idb.js";
import {
  ACCOUNTS,
  idbReq,
  legacyHistoryStore,
} from "./history-backup-legacy.js";
import { HISTORY_BACKUP_DATABASE } from "./storage-ownership.js";
import { legacyPasswordDigestStore } from "./vault/password-history-legacy.js";
import {
  installPasswordDigestStore,
  noteRetiredPassword,
  resetPasswordHistoryForTest,
} from "./vault/password-history.js";

afterEach(() => {
  installHistoryRowStore(null);
  installPasswordDigestStore(null);
  resetPasswordHistoryForTest();
  forgetAtRestKeyForTest();
  resetHistoryBackupMemory();
  configureHost(createTestHost());
});

it("resets a legacy sweep loaded before the wrapper's first fallback", async () => {
  const factory = new IDBFactory();
  configureHost(createTestHost({ indexedDB: factory, keyRange: IDBKeyRange }));
  expect(await legacyHistoryStore.listAccounts()).toEqual([]);
  const db = await idbReq(factory.open(HISTORY_BACKUP_DATABASE, 1));
  const account = {
    id: "legacy-cross-import",
    providerId: "postgres",
    anonToken: "old-private-handle",
    claimState: "provisional" as const,
    createdAt: "2026-10-06T00:00:00.000Z",
  };
  const write = db.transaction(ACCOUNTS, "readwrite");
  const committed = new Promise<void>((resolve, reject) => {
    write.oncomplete = () => resolve();
    write.onabort = () => reject(write.error);
  });
  await idbReq(write.objectStore(ACCOUNTS).put(account));
  await committed;

  resetHistoryBackupMemory();
  expect(await listHistoryAccounts()).toEqual([account]);
  const row = await idbReq(
    db.transaction(ACCOUNTS, "readonly").objectStore(ACCOUNTS).get(account.id),
  );
  expect(JSON.stringify(row)).not.toContain(account.anonToken);
  expect(row).toEqual({
    id: account.id,
    sealed: expect.stringMatching(/^osr2\./),
  });
  db.close();
});

it("keeps a pending fallback write in the store selected before encrypted routing", async () => {
  configureHost(
    createTestHost({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange }),
  );
  const account = {
    id: "selected-before-import",
    providerId: "postgres",
    anonToken: "original-route-handle",
    claimState: "provisional" as const,
    createdAt: "2026-10-06T00:00:00.000Z",
  };
  const pending = putHistoryAccount(account);
  const encrypted = createHistoryStore();
  installHistoryRowStore(encrypted);
  await pending;
  expect(await legacyHistoryStore.getAccount(account.id)).toEqual(account);
  expect(await encrypted.getAccount(account.id)).toBeUndefined();
});

it("keeps password routing selected before the digest await", async () => {
  configureHost(
    createTestHost({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange }),
  );
  const scope = "owner\u0000selected-before-hash";
  const password = "retired-original-route";
  const expected = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const encrypted = createPasswordDigestStore();
  expect(await encrypted.add("control", expected)).toBe(true);
  expect(await encrypted.digestsFor("control")).toEqual([expected]);
  const pending = noteRetiredPassword(scope, password);
  installPasswordDigestStore(encrypted);
  await pending;
  expect(await legacyPasswordDigestStore.digestsFor(scope)).toEqual([expected]);
  expect(await encrypted.digestsFor(scope)).toEqual([]);
});

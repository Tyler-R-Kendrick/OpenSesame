import { IDBDatabase } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { forgetAtRestKeyForTest } from "../at-rest/key.js";
import { putHistoryAccount } from "../history-backup-idb.js";
import { idbReq, legacyHistoryStore } from "../history-backup-legacy.js";
import { claimLegacyTransfer, openLegacySource } from "../legacy-transfer.js";
import {
  EDB_DATABASE_PREFIX,
  HISTORY_BACKUP_DATABASE,
} from "../storage-ownership.js";
import { freshIndexedDb } from "./edb.test-support.js";
import * as historyTarget from "./history-store.js";
import { type EncryptedStores, installEncryptedStores } from "./install.js";
import * as snapshot from "./legacy-history.js";

let factory: IDBFactory;
let installs: EncryptedStores[] = [];
beforeEach(() => {
  factory = freshIndexedDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const install of installs) await install.uninstall();
  installs = [];
  forgetAtRestKeyForTest();
  configureHost(createTestHost());
});
const account = () => ({
  id: crypto.randomUUID(),
  providerId: "postgres",
  anonToken: crypto.randomUUID(),
  claimState: "provisional" as const,
  createdAt: new Date().toISOString(),
});
const activate = () => {
  const install = installEncryptedStores();
  installs.push(install);
  return install;
};

it("seals a no-source handoff and refuses later legacy durable acknowledgement", async () => {
  const install = activate();
  expect((await install.migrated).complete).toBe(true);
  await expect(legacyHistoryStore.putAccount(account())).rejects.toThrow(
    /transferred/,
  );
  expect((await factory.databases()).map((row) => row.name)).not.toContain(
    HISTORY_BACKUP_DATABASE,
  );
});

it("an old uninstall cannot clear a newer routing or its handoff marker", async () => {
  const first = activate();
  await first.migrated;
  const second = activate();
  expect((await second.migrated).complete).toBe(true);
  await first.uninstall();
  const row = account();
  await putHistoryAccount(row);
  await expect(legacyHistoryStore.putAccount(account())).rejects.toThrow(
    /transferred/,
  );
  expect((await factory.databases()).map((entry) => entry.name)).not.toContain(
    HISTORY_BACKUP_DATABASE,
  );
});

it("a persisted interrupted claim can restart without empowering the stale owner", async () => {
  const stale = await claimLegacyTransfer("history-backups");
  configureHost(createTestHost({ indexedDB: factory }));
  const resumed = await claimLegacyTransfer("history-backups", true);
  await expect(stale.assertOwned()).rejects.toThrow(/ownership changed/);
  await stale.release();
  await resumed.assertOwned();
  await expect(legacyHistoryStore.putAccount(account())).rejects.toThrow(
    /transferred/,
  );
  await resumed.release();
  expect(await legacyHistoryStore.putAccount(account())).toBe(true);
});

it("a blocked fence retains the source and aborts its later upgrade", async () => {
  const row = account();
  expect(await legacyHistoryStore.putAccount(row)).toBe(true);
  const unresponsive = await idbReq(factory.open(HISTORY_BACKUP_DATABASE, 1));
  const install = activate();
  expect((await install.migrated).complete).toBe(false);
  await expect(putHistoryAccount(account())).rejects.toThrow(/incomplete/);
  unresponsive.close();
  const reopened = await idbReq(factory.open(HISTORY_BACKUP_DATABASE, 1));
  expect(reopened.version).toBe(1);
  reopened.close();
  expect(await legacyHistoryStore.getAccount(row.id)).toEqual(row);
});

it("a real target transaction failure retains the fenced source and permits retry", async () => {
  const row = account();
  expect(await legacyHistoryStore.putAccount(row)).toBe(true);
  const original = IDBDatabase.prototype.transaction;
  let failed = false;
  const transaction = vi
    .spyOn(IDBDatabase.prototype, "transaction")
    .mockImplementation(function (this: IDBDatabase, stores, mode, options) {
      if (
        this.name.startsWith(EDB_DATABASE_PREFIX) &&
        mode === "readwrite" &&
        failed
      ) {
        failed = false;
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return original.call(this, stores, mode, options);
    });
  const read = snapshot.readLegacyHistoryFrom;
  vi.spyOn(snapshot, "readLegacyHistoryFrom").mockImplementation(
    async (...args) => {
      const rows = await read(...args);
      failed = true;
      return rows;
    },
  );
  const broken = activate();
  expect((await broken.migrated).complete).toBe(false);
  await expect(putHistoryAccount(account())).rejects.toThrow(/incomplete/);
  transaction.mockRestore();
  vi.restoreAllMocks();
  expect(await legacyHistoryStore.getAccount(row.id)).toEqual(row);
  const retry = activate();
  expect((await retry.migrated).complete).toBe(true);
});

it("a legacy operation already pending cannot acknowledge after handoff", async () => {
  const pending = legacyHistoryStore.putAccount(account());
  const claim = await claimLegacyTransfer("history-backups");
  try {
    await expect(pending).rejects.toThrow(/transferred/);
  } finally {
    await claim.release();
  }
});

it("an old copy cannot overwrite a newer target update after restart", async () => {
  const row = account();
  expect(await legacyHistoryStore.putAccount(row)).toBe(true);
  let release = () => {};
  let entered = () => {};
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const create = historyTarget.createHistoryStore;
  const held = vi
    .spyOn(historyTarget, "createHistoryStore")
    .mockImplementation((_ready, guard) =>
      create(async () => {
        entered();
        await resume;
      }, guard),
    );
  const old = activate();
  await ready;
  held.mockRestore();
  const retry = activate();
  expect((await retry.migrated).complete).toBe(true);
  const newer = { ...row, anonToken: crypto.randomUUID() };
  const target = create();
  expect(await target.putAccount(newer)).toBe(true);
  release();
  expect((await old.migrated).complete).toBe(false);
  expect(await target.getAccount(row.id)).toEqual(newer);
});

it("a peer cannot acknowledge a legacy write while a target copy is awaiting completion", async () => {
  const row = account();
  expect(await legacyHistoryStore.putAccount(row)).toBe(true);
  let release = () => {};
  let copied = () => {};
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    copied = resolve;
  });
  const create = historyTarget.createHistoryStore;
  vi.spyOn(historyTarget, "createHistoryStore").mockImplementation(
    (wait, guard) => {
      const target = create(wait, guard);
      return {
        ...target,
        putAccount: async (account) => {
          const committed = await target.putAccount(account);
          copied();
          await resume;
          return committed;
        },
      };
    },
  );
  const install = activate();
  await ready;
  try {
    await expect(legacyHistoryStore.putAccount(account())).rejects.toThrow(
      /transferred/,
    );
  } finally {
    release();
  }
  expect((await install.migrated).complete).toBe(true);
  expect(await create().getAccount(row.id)).toEqual(row);
});

it("times out a retry queued behind an unresponsive peer without a late fence", async () => {
  const row = account();
  expect(await legacyHistoryStore.putAccount(row)).toBe(true);
  const peer = await idbReq(factory.open(HISTORY_BACKUP_DATABASE, 1));
  expect((await activate().migrated).complete).toBe(false);
  await expect(openLegacySource(HISTORY_BACKUP_DATABASE)).rejects.toThrow(
    /timed out/,
  );
  peer.close();
  const reopened = await idbReq(factory.open(HISTORY_BACKUP_DATABASE, 1));
  expect(reopened.version).toBe(1);
  reopened.close();
  expect(await legacyHistoryStore.getAccount(row.id)).toEqual(row);
});

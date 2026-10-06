import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { forgetAtRestKeyForTest } from "../at-rest/key.js";
import { clearDatabases } from "../browser-reset-areas.js";
import {
  appendHistoryEntry,
  getHistoryAccount,
  holdsAnyHistoryEntry,
  installHistoryRowStore,
  listHistoryAccounts,
  listHistoryEntries,
  putHistoryAccount,
  resetHistoryBackupMemory,
} from "../history-backup-idb.js";
import {
  HISTORY_BACKUP_DATABASE,
  PASSWORD_HISTORY_DATABASE,
} from "../storage-ownership.js";
import {
  forgetRetiredPasswords,
  installPasswordDigestStore,
  noteRetiredPassword,
  passwordPreviouslyUsed,
  resetPasswordHistoryForTest,
} from "../vault/password-history.js";
import { freshIndexedDb, rawDisk } from "./edb.test-support.js";
import { type EncryptedStores, installEncryptedStores } from "./install.js";

let factory: IDBFactory;
let installed: EncryptedStores | undefined;

const account = (id: string) => ({
  id,
  providerId: "supabase-eu-west",
  anonToken: "anon-secret-token",
  claimState: "provisional" as const,
  createdAt: "2026-05-05T05:05:05.000Z",
});

const databaseNames = async () =>
  (await factory.databases()).map((entry) => entry.name);

beforeEach(() => {
  factory = freshIndexedDb();
  resetHistoryBackupMemory();
  resetPasswordHistoryForTest();
});

afterEach(async () => {
  await installed?.uninstall();
  installed = undefined;
  installHistoryRowStore(null);
  installPasswordDigestStore(null);
  forgetAtRestKeyForTest();
});

describe("history backups in an encrypted database", () => {
  it("round-trips accounts and snapshots, found by account", async () => {
    installed = installEncryptedStores();
    await installed.migrated;
    await putHistoryAccount(account("hacc_one"));
    await putHistoryAccount(account("hacc_two"));
    const a = await appendHistoryEntry("hacc_one", new Uint8Array([1, 2, 3]));
    const b = await appendHistoryEntry("hacc_one", new Uint8Array([4, 5]));
    await appendHistoryEntry("hacc_two", new Uint8Array([6]));
    expect((await getHistoryAccount("hacc_one"))?.providerId).toBe(
      "supabase-eu-west",
    );
    expect((await listHistoryAccounts()).map((row) => row.id).sort()).toEqual([
      "hacc_one",
      "hacc_two",
    ]);
    expect((await listHistoryEntries("hacc_one")).map((row) => row.id)).toEqual(
      [a.id, b.id],
    );
    expect(await holdsAnyHistoryEntry()).toBe(true);
  });

  it("leaves no id, provider, token or name on the disk", async () => {
    installed = installEncryptedStores();
    await installed.migrated;
    await putHistoryAccount(account("hacc_one"));
    await appendHistoryEntry("hacc_one", new Uint8Array([1, 2, 3]));
    await listHistoryEntries("hacc_one");
    const disk = await rawDisk(factory);
    expect(disk.records.length).toBeGreaterThan(2);
    const all =
      (await databaseNames()).join("\n") +
      disk.records.map((r) => `${String(r.key)}${r.value}`).join("\n");
    for (const secret of [
      "hacc_one",
      "hent_",
      "supabase",
      "anon-secret",
      "accounts",
      "entries",
      "accountId",
      "history",
    ]) {
      expect(all).not.toContain(secret);
    }
    expect(await databaseNames()).not.toContain(HISTORY_BACKUP_DATABASE);
  });

  it("holds nothing in the clear without a durable key, and keeps it in memory", async () => {
    forgetAtRestKeyForTest();
    configureHost(
      createTestHost({ indexedDB: factory, atRestKeys: undefined }),
    );
    installed = installEncryptedStores();
    await installed.migrated;
    await putHistoryAccount(account("hacc_mem"));
    expect((await listHistoryAccounts()).map((row) => row.id)).toEqual([
      "hacc_mem",
    ]);
    expect(await databaseNames()).toEqual([]);
  });

  it("moves what the device-sealed database held, then deletes it", async () => {
    await putHistoryAccount(account("hacc_old"));
    await appendHistoryEntry("hacc_old", new Uint8Array([9, 9]));
    expect(await databaseNames()).toContain(HISTORY_BACKUP_DATABASE);
    resetHistoryBackupMemory();

    installed = installEncryptedStores();
    const report = await installed.migrated;

    expect(report.history).toEqual({ moved: 2, removed: true });
    expect(await databaseNames()).not.toContain(HISTORY_BACKUP_DATABASE);
    expect((await getHistoryAccount("hacc_old"))?.id).toBe("hacc_old");
    expect(await listHistoryEntries("hacc_old")).toHaveLength(1);
  });

  it("creates nothing to move when there was nothing", async () => {
    installed = installEncryptedStores();
    const report = await installed.migrated;
    expect(report.history).toEqual({ moved: 0, removed: false });
    expect(await databaseNames()).not.toContain(HISTORY_BACKUP_DATABASE);
    expect(await databaseNames()).not.toContain(PASSWORD_HISTORY_DATABASE);
  });

  it("routes back to the sealed database when the capability goes", async () => {
    installed = installEncryptedStores();
    await installed.migrated;
    await installed.uninstall();
    installed = undefined;
    await putHistoryAccount(account("hacc_back"));
    expect(await databaseNames()).toContain(HISTORY_BACKUP_DATABASE);
  });
});

describe("retired-password digests in an encrypted database", () => {
  const scope = "personal-tomb\u0000item-4411";

  it("recognises a retired password and forgets an item's", async () => {
    installed = installEncryptedStores();
    await installed.migrated;
    await noteRetiredPassword(scope, "hunter2");
    resetPasswordHistoryForTest();
    expect(await passwordPreviouslyUsed(scope, "hunter2")).toBe(true);
    expect(await passwordPreviouslyUsed(scope, "hunter3")).toBe(false);
    expect(
      await passwordPreviouslyUsed("personal-tomb\u0000item-9", "hunter2"),
    ).toBe(false);
    expect(await forgetRetiredPasswords("personal-tomb", ["item-4411"])).toBe(
      1,
    );
    resetPasswordHistoryForTest();
    expect(await passwordPreviouslyUsed(scope, "hunter2")).toBe(false);
  });

  it("leaves no vault name, item id or digest on the disk", async () => {
    installed = installEncryptedStores();
    await installed.migrated;
    await noteRetiredPassword(scope, "hunter2");
    resetPasswordHistoryForTest();
    await passwordPreviouslyUsed(scope, "hunter2");
    const disk = await rawDisk(factory);
    expect(disk.records.length).toBeGreaterThan(1);
    const all = disk.records
      .map((r) => `${String(r.key)}${r.value}`)
      .join("\n");
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("hunter2"),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    for (const secret of [
      "personal-tomb",
      "item-4411",
      digest,
      "digests",
      "scope",
    ]) {
      expect(all).not.toContain(secret);
    }
    expect(await databaseNames()).not.toContain(PASSWORD_HISTORY_DATABASE);
  });

  it("moves the sealed database's digests across and deletes it", async () => {
    await noteRetiredPassword(scope, "hunter2");
    expect(await databaseNames()).toContain(PASSWORD_HISTORY_DATABASE);
    resetPasswordHistoryForTest();
    installed = installEncryptedStores();
    const report = await installed.migrated;
    expect(report.digests).toEqual({ moved: 1, removed: true });
    expect(await databaseNames()).not.toContain(PASSWORD_HISTORY_DATABASE);
    expect(await passwordPreviouslyUsed(scope, "hunter2")).toBe(true);
  });
});

describe("Reset this browser", () => {
  it("finds them by derivation where the browser cannot list databases", async () => {
    const { IDBKeyRange } = await import("fake-indexeddb");
    const unlisted: Pick<IDBFactory, "open" | "deleteDatabase" | "cmp"> = {
      open: (name, version) => factory.open(name, version),
      deleteDatabase: (name) => factory.deleteDatabase(name),
      cmp: (a, b) => factory.cmp(a, b),
    };
    forgetAtRestKeyForTest();
    configureHost(
      createTestHost({
        indexedDB: overlapCast(unlisted),
        keyRange: IDBKeyRange,
      }),
    );
    installed = installEncryptedStores();
    await installed.migrated;
    await putHistoryAccount(account("hacc_one"));
    await noteRetiredPassword("t\u0000i", "pw");
    expect((await databaseNames()).length).toBe(2);
    await clearDatabases();
    expect(await databaseNames()).toEqual([]);
  });

  it("deletes the encrypted databases, whose names are hashes", async () => {
    installed = installEncryptedStores();
    await installed.migrated;
    await putHistoryAccount(account("hacc_one"));
    await noteRetiredPassword("t\u0000i", "pw");
    const before = (await databaseNames()).filter((name) =>
      name?.startsWith("opensesame-edb-"),
    );
    expect(before).toHaveLength(2);
    await clearDatabases();
    expect(await databaseNames()).toEqual([]);
  });
});

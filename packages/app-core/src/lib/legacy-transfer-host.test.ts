import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createNodeHost } from "../node/host.js";
import { createTestHost } from "../test-host.js";
import { atRestReady, forgetAtRestKeyForTest } from "./at-rest/key.js";
import { installEncryptedStores } from "./encrypted-db/install.js";
import {
  getHistoryAccount,
  putHistoryAccount,
  resetHistoryBackupMemory,
} from "./history-backup-idb.js";
import { legacyHistoryStore } from "./history-backup-legacy.js";
import { resumeStorageWritesForTest } from "./storage-halt.js";
import { legacyPasswordDigestStore } from "./vault/password-history-legacy.js";
import {
  noteRetiredPassword,
  passwordPreviouslyUsed,
  resetPasswordHistoryForTest,
} from "./vault/password-history.js";

let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  resumeStorageWritesForTest();
  resetHistoryBackupMemory();
  resetPasswordHistoryForTest();
  forgetAtRestKeyForTest();
  configureHost(createTestHost());
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
const account = () => ({
  id: crypto.randomUUID(),
  providerId: "postgres",
  anonToken: crypto.randomUUID(),
  claimState: "provisional" as const,
  createdAt: new Date().toISOString(),
});

it("keeps ordinary Node history in memory without a false durable acknowledgement", async () => {
  directory = await mkdtemp(join(tmpdir(), "os-no-idb-history-"));
  configureHost(createNodeHost({ stateDir: directory }));
  expect((await atRestReady()).durable).toBe(true);
  const row = account();
  await putHistoryAccount(row);
  expect(await getHistoryAccount(row.id)).toEqual(row);
  expect(await legacyHistoryStore.putAccount(account())).toBeUndefined();
  await noteRetiredPassword("node-scope", "retired-node-password");
  expect(
    await passwordPreviouslyUsed("node-scope", "retired-node-password"),
  ).toBe(true);
  expect(
    await legacyPasswordDigestStore.add("node-scope", "a".repeat(64)),
  ).toBeUndefined();
  const encrypted = installEncryptedStores();
  try {
    expect((await encrypted.migrated).complete).toBe(false);
    await expect(putHistoryAccount(account())).rejects.toThrow(/incomplete/);
  } finally {
    await encrypted.uninstall();
  }
});

it("keeps ephemeral-key IndexedDB history memory-only", async () => {
  const factory = new IDBFactory();
  configureHost(createTestHost({ indexedDB: factory, atRestKeys: undefined }));
  expect((await atRestReady()).durable).toBe(false);
  const row = account();
  await putHistoryAccount(row);
  expect(await getHistoryAccount(row.id)).toEqual(row);
  await noteRetiredPassword("ephemeral-scope", "retired-ephemeral-password");
  expect(
    await passwordPreviouslyUsed(
      "ephemeral-scope",
      "retired-ephemeral-password",
    ),
  ).toBe(true);
  expect(await legacyHistoryStore.putAccount(account())).toBeUndefined();
  expect(await factory.databases()).toEqual([]);
});

it("still refuses marker-storage errors when IndexedDB and a durable key exist", async () => {
  const factory = new IDBFactory();
  configureHost(createTestHost({ indexedDB: factory }));
  expect((await atRestReady()).durable).toBe(true);
  vi.spyOn(factory, "open").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  await expect(legacyHistoryStore.putAccount(account())).rejects.toThrow(
    /unavailable/,
  );
  await expect(
    legacyPasswordDigestStore.add("real-idb-scope", "b".repeat(64)),
  ).rejects.toThrow(/unavailable/);
});

import { configureHost } from "@opensesame/app-core/host.js";
import { forgetAtRestKeyForTest } from "@opensesame/app-core/lib/at-rest/key.js";
import { freshIndexedDb } from "@opensesame/app-core/lib/encrypted-db/edb.test-support.js";
import { putHistoryAccount } from "@opensesame/app-core/lib/history-backup-idb.js";
import {
  idbReq,
  legacyHistoryStore,
} from "@opensesame/app-core/lib/history-backup-legacy.js";
import { HISTORY_BACKUP_DATABASE } from "@opensesame/app-core/lib/storage-ownership.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestContext } from "../test-context.js";
import { capabilityRuntime } from "./runtime.js";

let factory: IDBFactory;
beforeEach(() => {
  factory = freshIndexedDb();
});
afterEach(() => {
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

it("activates after transfer and awaits deliberate handback on disposal", async () => {
  const handle = await capabilityRuntime.activate(createTestContext().ctx);
  await expect(legacyHistoryStore.putAccount(account())).rejects.toThrow(
    /transferred/,
  );
  await handle.dispose();
  expect(await legacyHistoryStore.putAccount(account())).toBe(true);
  await handle.dispose();
});

it("refuses blocked activation without hiding the source and permits real retry", async () => {
  const row = account();
  expect(await legacyHistoryStore.putAccount(row)).toBe(true);
  const peer = await idbReq(factory.open(HISTORY_BACKUP_DATABASE, 1));
  await expect(
    capabilityRuntime.activate(createTestContext().ctx),
  ).rejects.toThrow(/incomplete/);
  peer.close();
  expect(await legacyHistoryStore.getAccount(row.id)).toEqual(row);
  const handle = await capabilityRuntime.activate(createTestContext().ctx);
  await putHistoryAccount(account());
  expect((await factory.databases()).map((db) => db.name)).not.toContain(
    HISTORY_BACKUP_DATABASE,
  );
  await handle.dispose();
});

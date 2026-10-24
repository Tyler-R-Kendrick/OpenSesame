/** @vitest-environment jsdom */
/** Real legacy encryption over the existing IDB fixture; only actual open completion is held. */
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { fakeIndexedDb, rawRows } from "./at-rest/fake-idb.test-support.js";
import { atRestReady, forgetAtRestKeyForTest } from "./at-rest/key.js";
import {
  bindLegacyHistoryStore,
  legacyHistoryStore,
  resetLegacyHistorySweep,
} from "./history-backup-legacy.js";
import {
  haltStorageWrites,
  resumeStorageWritesForTest,
} from "./storage-halt.js";
import { HISTORY_BACKUP_DATABASE } from "./storage-ownership.js";

function deferred() {
  let complete = () => {};
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, release: () => complete() };
}
const releases: (() => void)[] = [];
const tasks: Promise<unknown>[] = [];
const account = {
  id: "owned-legacy-account",
  providerId: "neon",
  anonToken: "never-retarget-this-credential",
  claimState: "provisional" as const,
  createdAt: "2026-10-24T00:00:00Z",
};
async function originalStore(held = false) {
  resetLegacyHistorySweep();
  forgetAtRestKeyForTest();
  const db = fakeIndexedDb();
  const gate = deferred();
  const seen = deferred();
  const open = db.factory.open.bind(db.factory);
  if (held)
    vi.spyOn(db.factory, "open").mockImplementation((...args) => {
      const request = open(...args);
      let callback: IDBOpenDBRequest["onsuccess"] = null;
      Object.defineProperty(request, "onsuccess", {
        get: () => () => {
          seen.release();
          void gate.promise.then(() =>
            callback?.call(request, new Event("success")),
          );
        },
        set: (next: IDBOpenDBRequest["onsuccess"]) => {
          callback = next;
        },
      });
      return request;
    });
  releases.push(gate.release);
  configureHost(createTestHost({ indexedDB: db.factory }));
  await atRestReady();
  let current = true;
  const store = bindLegacyHistoryStore(() => {
    if (!current) throw new Error("Original history owner ended");
  });
  return {
    ...db,
    store,
    gate,
    seen,
    end: () => {
      current = false;
    },
  };
}
function put(store: Awaited<ReturnType<typeof originalStore>>["store"]) {
  const task = store.putAccount({ ...account });
  tasks.push(task.catch(() => undefined));
  return task;
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(tasks.splice(0));
  resumeStorageWritesForTest();
  resetLegacyHistorySweep();
  forgetAtRestKeyForTest();
  configureHost(createTestHost());
  vi.restoreAllMocks();
});
it("writes the actual seal through its bound store and cold-reads it through the original public API", async () => {
  const original = await originalStore();
  await expect(put(original.store)).resolves.toBe(true);
  const sealed = rawRows(
    original.databases,
    HISTORY_BACKUP_DATABASE,
    "accounts",
  );
  expect(sealed).toHaveLength(1);
  expect(sealed[0]?.sealed).toEqual(expect.any(String));
  expect(JSON.stringify(sealed)).not.toContain(account.anonToken);
  resetLegacyHistorySweep();
  expect(await legacyHistoryStore.getAccount(account.id)).toEqual(account);
});
it("cannot read a newly configured database after the original real IDB open is held", async () => {
  const original = await originalStore(true);
  const task = put(original.store);
  await original.seen.promise;
  const replacement = fakeIndexedDb();
  configureHost(createTestHost({ indexedDB: replacement.factory }));
  const refused = expect(task).rejects.toThrow(
    "history storage operation ended",
  );
  original.gate.release();
  await refused;
  expect(
    rawRows(original.databases, HISTORY_BACKUP_DATABASE, "accounts"),
  ).toEqual([]);
  expect(replacement.databases.size).toBe(0);
});
it("cannot adopt a replacement device key across the held original open", async () => {
  const original = await originalStore(true);
  const task = put(original.store);
  await original.seen.promise;
  forgetAtRestKeyForTest();
  await atRestReady();
  const refused = expect(task).rejects.toThrow(
    "history storage operation ended",
  );
  original.gate.release();
  await refused;
  expect(
    rawRows(original.databases, HISTORY_BACKUP_DATABASE, "accounts"),
  ).toEqual([]);
});
it("honors the original operation cancellation after its real database answered", async () => {
  const original = await originalStore(true);
  const task = put(original.store);
  await original.seen.promise;
  original.end();
  const refused = expect(task).rejects.toThrow("Original history owner ended");
  original.gate.release();
  await refused;
  expect(
    rawRows(original.databases, HISTORY_BACKUP_DATABASE, "accounts"),
  ).toEqual([]);
});
it("cannot recreate rows after writes halt while open completion is held", async () => {
  const original = await originalStore(true);
  const task = put(original.store);
  await original.seen.promise;
  haltStorageWrites();
  const refused = expect(task).rejects.toThrow(
    "history storage operation ended",
  );
  original.gate.release();
  await refused;
  expect(
    rawRows(original.databases, HISTORY_BACKUP_DATABASE, "accounts"),
  ).toEqual([]);
});

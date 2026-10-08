import type { JsonObject } from "@opensesame/os-domain";
import { afterEach, expect, it } from "vitest";
import { ACCOUNTS, DB_VERSION, ENTRIES } from "../history-backup-legacy.js";
import { HISTORY_BACKUP_DATABASE } from "../storage-ownership.js";
import { type EncryptedDb, openEncryptedDb } from "./db.js";
import { freshIndexedDb, receipt, receiptSchema } from "./edb.test-support.js";
import { installEncryptedStores } from "./install.js";
import { deriveEdbKeys } from "./keys.js";
import { readLegacyHistory } from "./legacy-history.js";
import { openRow, openSealed, sealPadded, sealRow } from "./rows.js";

const opened: EncryptedDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

it("separates wrapping keys, metadata, pseudonyms and index tokens by trusted customer", () => {
  const root = crypto.getRandomValues(new Uint8Array(32));
  const a = deriveEdbKeys(root, "same", "customer\u0000a");
  const b = deriveEdbKeys(root, "same", "customer\u0000b");
  const row = receipt("same-id", "same-user", "2026-01-01T00:00:00Z");
  expect(a.databaseName).not.toBe(b.databaseName);
  expect(a.sealKey).not.toEqual(b.sealKey);
  expect(a.rowId("receipts", "same-id")).not.toBe(
    b.rowId("receipts", "same-id"),
  );
  expect(a.token("eq", "same-column", "same-value")).not.toBe(
    b.token("eq", "same-column", "same-value"),
  );
  expect(a.opeKey("receipts", "at", 100n)).not.toEqual(
    b.opeKey("receipts", "at", 100n),
  );
  const sealed = sealRow(a, "receipts", "same-id", row);
  expect(openRow(b, a.rowId("receipts", "same-id"), sealed)).toBeNull();
  expect(openRow(b, b.rowId("receipts", "same-id"), sealed)).toBeNull();
  const meta = sealPadded(a, a.metaId, JSON.stringify({ v: 1, layers: {} }));
  expect(openSealed(b, b.metaId, meta)).toBeNull();
  expect(() => deriveEdbKeys(root, "same", "")).toThrow();
  a.wipe();
  b.wipe();
});

it("isolates equal IDs in the same schema and rejects customer row/index transplant", async () => {
  const factory = freshIndexedDb();
  const a = await openEncryptedDb("same", receiptSchema, "A");
  const b = await openEncryptedDb("same", receiptSchema, "B");
  opened.push(a, b);
  await a.put("receipts", receipt("same", "alice", "2026-01-01T00:00:00Z"));
  await b.put("receipts", receipt("same", "bob", "2026-01-01T00:00:00Z"));
  await a.find("receipts", { userId: "alice" });
  await b.find("receipts", { userId: "bob" });
  expect((await a.get("receipts", "same"))?.userId).toBe("alice");
  expect((await b.get("receipts", "same"))?.userId).toBe("bob");
  const raw = async (name: string) =>
    new Promise<IDBDatabase>((resolve) => {
      const req = factory.open(name);
      req.onsuccess = () => resolve(req.result);
    });
  const source = await raw(a.name);
  const target = await raw(b.name);
  const records = await new Promise<{ key: IDBValidKey; value: unknown }[]>(
    (resolve) => {
      const found: { key: IDBValidKey; value: unknown }[] = [];
      const req = source.transaction("r").objectStore("r").openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(found);
        found.push({ key: c.key, value: c.value });
        c.continue();
      };
    },
  );
  const tx = target.transaction("r", "readwrite");
  for (const row of records) tx.objectStore("r").put(row.value, row.key);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
  });
  expect(await b.find("receipts", { userId: "alice" })).toEqual([]);
  expect((await b.all("receipts")).map((row) => row.userId)).toEqual(["bob"]);
  source.close();
  target.close();
});

it.each([undefined, "osr2.corrupted"])(
  "routine import preserves unauthenticated history (%s)",
  async (sealed) => {
    const factory = freshIndexedDb();
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = factory.open(HISTORY_BACKUP_DATABASE, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(ACCOUNTS, { keyPath: "id" });
        req.result.createObjectStore(ENTRIES, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
    });
    const tx = db.transaction(ACCOUNTS, "readwrite");
    const record: JsonObject = {
      id: "replayed",
      providerId: "provider",
      anonToken: "bearer",
      claimState: "provisional",
      createdAt: "2026-01-01",
    };
    if (sealed !== undefined) record.sealed = sealed;
    tx.objectStore(ACCOUNTS).put(record);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    db.close();
    expect(await readLegacyHistory()).toBeUndefined();
    const installed = installEncryptedStores();
    const report = await installed.migrated;
    expect(report.complete).toBe(false);
    expect(report.history).toEqual({
      moved: 0,
      removed: false,
    });
    await installed.uninstall();
    expect(
      (await factory.databases()).some(
        (entry) => entry.name === HISTORY_BACKUP_DATABASE,
      ),
    ).toBe(true);
  },
);

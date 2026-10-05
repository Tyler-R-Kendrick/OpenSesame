/**
 * What the encrypted-database suites share: a host over a fresh fake
 * IndexedDB, and a reader that sees exactly what reached the disk.
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { forgetAtRestKeyForTest } from "../at-rest/key.js";
import { defineSchema } from "./schema.js";

export function freshIndexedDb(): IDBFactory {
  forgetAtRestKeyForTest();
  const factory = new IDBFactory();
  configureHost(createTestHost({ indexedDB: factory, keyRange: IDBKeyRange }));
  return factory;
}

export const receiptSchema = defineSchema({
  receipts: {
    key: "id",
    columns: {
      userId: { eq: { group: "principal" } },
      action: { eq: true },
      at: { order: { type: "time" } },
      amount: { order: { type: "int", min: 0, max: 1_000_000 } },
      note: { keyword: { prefix: 3 } },
      tags: { eq: true },
    },
  },
  sessions: {
    key: "id",
    columns: { userId: { eq: { group: "principal" } } },
  },
});

export type RawRecord = { database: string; key: IDBValidKey; value: string };

export type StoreLayout = { stores: string[]; indexes: string[] };

export type RawDisk = {
  names: string[];
  layouts: StoreLayout[];
  records: RawRecord[];
};

/** Every record of every encrypted database, as the browser holds it. */
export async function rawDisk(factory: IDBFactory): Promise<RawDisk> {
  const listed = await factory.databases();
  const names = listed.map((entry) => entry.name ?? "");
  const layouts: StoreLayout[] = [];
  const records: RawRecord[] = [];
  for (const name of names) {
    if (!name.startsWith("opensesame-edb-")) continue;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const stores = [...db.objectStoreNames];
    const tx = db.transaction(stores, "readonly");
    layouts.push({
      stores,
      indexes: stores.flatMap((store) => [...tx.objectStore(store).indexNames]),
    });
    for (const store of stores) {
      await new Promise<void>((resolve, reject) => {
        const cursorReq = tx.objectStore(store).openCursor();
        cursorReq.onerror = () => reject(cursorReq.error);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          records.push({
            database: name,
            key: cursor.primaryKey,
            value: JSON.stringify(cursor.value),
          });
          cursor.continue();
        };
      });
    }
    db.close();
  }
  return { names, layouts, records };
}

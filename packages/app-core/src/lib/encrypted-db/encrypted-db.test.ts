import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetAtRestKeyForTest } from "../at-rest/key.js";
import { type EncryptedDb, openEncryptedDb } from "./db.js";
import {
  freshIndexedDb,
  ids,
  rawDisk,
  receipt,
  receiptSchema,
  seed,
} from "./edb.test-support.js";
import { EdbQueryError } from "./query.js";

let factory: IDBFactory;
let db: EncryptedDb;

beforeEach(async () => {
  factory = freshIndexedDb();
  db = await openEncryptedDb("receipts-test", receiptSchema);
});

afterEach(() => {
  db.close();
  forgetAtRestKeyForTest();
});

describe("rows", () => {
  it("round-trips, replaces and deletes by key", async () => {
    await seed(db);
    expect((await db.get("receipts", "r2"))?.userId).toBe("user-bob");
    await db.put(
      "receipts",
      receipt("r2", "user-dave", "2026-02-02T00:00:00Z"),
    );
    expect((await db.get("receipts", "r2"))?.userId).toBe("user-dave");
    await db.delete("receipts", "r2");
    expect(await db.get("receipts", "r2")).toBeUndefined();
    expect(await db.size()).toBe(4);
  });

  it("keeps a key from one table out of another", async () => {
    await seed(db);
    await db.put("sessions", { id: "r1", userId: "x" });
    expect((await db.get("receipts", "r1"))?.userId).toBe("user-alice");
    expect((await db.get("sessions", "r1"))?.userId).toBe("x");
  });

  it("refuses a row with no usable key, an unknown table, an out-of-domain value", async () => {
    await expect(db.put("receipts", { userId: "x" })).rejects.toThrow(
      EdbQueryError,
    );
    await expect(db.put("receipts", { id: "", userId: "x" })).rejects.toThrow(
      EdbQueryError,
    );
    await expect(db.get("nope", "k")).rejects.toThrow(/no table/);
    await expect(
      db.put(
        "receipts",
        receipt("r9", "u", "2026-01-01T00:00:00Z", { amount: -1 }),
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      db.put("receipts", receipt("r9", "u", "not a time")),
    ).rejects.toThrow(RangeError);
  });

  it("lists a table's rows by opening them, never another table's", async () => {
    await seed(db);
    expect(ids(await db.all("receipts"))).toEqual(["r1", "r2", "r3"]);
    expect(ids(await db.all("sessions"))).toEqual(["s1", "s2"]);
  });
});

describe("what reaches the disk", () => {
  it("holds no name, id, field or word in the clear", async () => {
    await seed(db);
    await db.find("receipts", { userId: "user-alice" });
    await db.find("receipts", { note: { word: "vault" } });
    await db.find("receipts", {}, { order: { column: "at" } });
    const disk = await rawDisk(factory);
    // A control: the records are there, sealed, so the absence below means something.
    expect(disk.records.length).toBe(6);
    expect(
      disk.records.every((r) => JSON.parse(r.value).c.startsWith("osr2.")),
    ).toBe(true);
    const everything = [
      ...disk.names,
      ...disk.records.map((r) => `${String(r.key)}${r.value}`),
    ].join("\n");
    for (const secret of [
      "user-alice",
      "user-bob",
      "alice",
      "vault",
      "review",
      "receipts",
      "sessions",
      "userId",
      "action",
      "approve",
      "2026",
      "unknown device",
      "quarterly",
      "tags",
      "history",
    ]) {
      expect(everything.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("shows one pseudonymous database with one store and one index", async () => {
    await seed(db);
    const disk = await rawDisk(factory);
    expect(disk.names).toHaveLength(1);
    expect(disk.names[0]).toMatch(/^opensesame-edb-[0-9a-f]{32}$/);
    expect(disk.layouts).toEqual([{ stores: ["r"], indexes: ["x"] }]);
    expect(disk.names[0]).toBe(db.name);
  });

  it("hides how long a row is, to a bucket", async () => {
    await db.put("sessions", { id: "a", userId: "x" });
    await db.put("sessions", {
      id: "bbbbbbbbbbbb",
      userId: "a-much-longer-user-id",
    });
    const disk = await rawDisk(factory);
    const sizes = new Set(disk.records.map((r) => r.value.length));
    expect(sizes.size).toBe(1);
  });

  it("builds nothing searchable until a query asks, and removes it on drop", async () => {
    await seed(db);
    const entries = async () => {
      const disk = await rawDisk(factory);
      return disk.records.reduce(
        (sum, r) => sum + (JSON.parse(r.value).x?.length ?? 0),
        0,
      );
    };
    expect(await entries()).toBe(0);
    expect((await db.layers()).every((l) => l.state === "dormant")).toBe(true);
    await db.find("receipts", { action: "deny" });
    expect(await entries()).toBeGreaterThan(0);
    expect((await db.layers()).find((l) => l.column === "action")?.state).toBe(
      "ready",
    );
    await db.drop("receipts", "action", "eq");
    expect(await entries()).toBe(0);
    expect((await db.layers()).find((l) => l.column === "action")?.state).toBe(
      "dormant",
    );
  });

  it("does not open a row that was moved to another slot", async () => {
    await seed(db);
    expect(await db.all("receipts")).toHaveLength(3);
    const name = db.name;
    db.close();
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = raw.transaction("r", "readwrite");
    const store = tx.objectStore("r");
    const slots = await new Promise<IDBValidKey[]>((resolve) => {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result);
    });
    const values = await new Promise<{ c: string; x: string[] }[]>(
      (resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
      },
    );
    // Rotate every sealed value one slot over.
    slots.forEach((slot, i) => {
      store.put(values[(i + 1) % values.length], slot);
    });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    raw.close();
    db = await openEncryptedDb("receipts-test", receiptSchema);
    expect(await db.all("receipts")).toEqual([]);
    expect(await db.get("receipts", "r1")).toBeUndefined();
  });
});

describe("layers", () => {
  it("builds on demand, once, over rows that were already there", async () => {
    await seed(db);
    await Promise.all([
      db.find("receipts", { action: "deny" }),
      db.find("receipts", { action: "approve" }),
    ]);
    await db.build("receipts", "action", "eq");
    expect(
      (await db.layers())
        .filter((l) => l.state === "ready")
        .map((l) => l.column),
    ).toEqual(["action"]);
  });

  it("is told nothing after the database is destroyed and reopened", async () => {
    await seed(db);
    await db.destroy();
    db = await openEncryptedDb("receipts-test", receiptSchema);
    expect(await db.size()).toBe(0);
    expect(await db.find("receipts", { action: "deny" })).toEqual([]);
  });
});

describe("keys", () => {
  it("opens nothing written under another device key", async () => {
    await seed(db);
    const first = db.name;
    db.close();
    forgetAtRestKeyForTest();
    const { configureHost } = await import("../../host.js");
    const { createTestHost } = await import("../../test-host.js");
    const { IDBKeyRange } = await import("fake-indexeddb");
    const other = crypto.getRandomValues(new Uint8Array(32));
    configureHost(
      createTestHost({
        indexedDB: factory,
        keyRange: IDBKeyRange,
        atRestKeys: { loadSync: () => other, load: async () => other },
      }),
    );
    db = await openEncryptedDb("receipts-test", receiptSchema);
    expect(db.name).not.toBe(first);
    expect(await db.all("receipts")).toEqual([]);
  });

  it("refuses to open with no durable key", async () => {
    db.close();
    forgetAtRestKeyForTest();
    const { configureHost } = await import("../../host.js");
    const { createTestHost } = await import("../../test-host.js");
    const { IDBKeyRange } = await import("fake-indexeddb");
    configureHost(
      createTestHost({
        indexedDB: factory,
        keyRange: IDBKeyRange,
        atRestKeys: undefined,
      }),
    );
    await expect(openEncryptedDb("x", receiptSchema)).rejects.toThrow(
      /unavailable/,
    );
  });
});

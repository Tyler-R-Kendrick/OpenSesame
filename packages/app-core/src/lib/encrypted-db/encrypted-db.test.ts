import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetAtRestKeyForTest } from "../at-rest/key.js";
import { type EncryptedDb, openEncryptedDb } from "./db.js";
import { EdbQueryError } from "./query.js";
import { freshIndexedDb, rawDisk, receiptSchema } from "./test-support.js";

let factory: IDBFactory;
let db: EncryptedDb;

type ReceiptExtras = Partial<{
  action: string;
  note: string;
  amount: number;
  tags: string[];
}>;

const receipt = (
  id: string,
  userId: string,
  at: string,
  extra: ReceiptExtras = {},
) => ({
  id,
  userId,
  action: "approve",
  at,
  amount: 10,
  note: "",
  tags: [],
  ...extra,
});

beforeEach(async () => {
  factory = freshIndexedDb();
  db = await openEncryptedDb("receipts-test", receiptSchema);
});

afterEach(() => {
  db.close();
  forgetAtRestKeyForTest();
});

async function seed() {
  await db.put(
    "receipts",
    receipt("r1", "user-alice", "2026-01-01T00:00:00Z", {
      note: "Quarterly vault review for Alice",
      tags: ["vault", "review"],
      amount: 100,
    }),
  );
  await db.put(
    "receipts",
    receipt("r2", "user-bob", "2026-02-01T00:00:00Z", {
      action: "deny",
      note: "Denied: unknown device",
      amount: 5,
    }),
  );
  await db.put(
    "receipts",
    receipt("r3", "user-alice", "2026-03-01T00:00:00Z", {
      note: "Vault key rotation",
      tags: ["vault"],
      amount: 50,
    }),
  );
  await db.put("sessions", { id: "s1", userId: "user-alice" });
  await db.put("sessions", { id: "s2", userId: "user-carol" });
}

const ids = (rows: readonly { id?: unknown }[]) =>
  rows.map((row) => row.id).sort();

describe("rows", () => {
  it("round-trips, replaces and deletes by key", async () => {
    await seed();
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
    await seed();
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
    await seed();
    expect(ids(await db.all("receipts"))).toEqual(["r1", "r2", "r3"]);
    expect(ids(await db.all("sessions"))).toEqual(["s1", "s2"]);
  });
});

describe("what reaches the disk", () => {
  it("holds no name, id, field or word in the clear", async () => {
    await seed();
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
    await seed();
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
    await seed();
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
    await seed();
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

describe("equality", () => {
  it("finds rows by a value without opening the others", async () => {
    await seed();
    expect(ids(await db.find("receipts", { action: "deny" }))).toEqual(["r2"]);
    expect(await db.find("receipts", { action: "nothing" })).toEqual([]);
  });

  it("finds an element of an array column", async () => {
    await seed();
    expect(ids(await db.find("receipts", { tags: "vault" }))).toEqual([
      "r1",
      "r3",
    ]);
    expect(ids(await db.find("receipts", { tags: "review" }))).toEqual(["r1"]);
  });

  it("joins a group across tables and keeps each table's rows apart", async () => {
    await seed();
    expect(ids(await db.find("receipts", { userId: "user-alice" }))).toEqual([
      "r1",
      "r3",
    ]);
    expect(ids(await db.find("sessions", { userId: "user-alice" }))).toEqual([
      "s1",
    ]);
  });

  it("does not match one column's value in another that is not in its group", async () => {
    await db.put("receipts", receipt("r1", "approve", "2026-01-01T00:00:00Z"));
    expect(await db.find("receipts", { userId: "deny" })).toEqual([]);
    expect(ids(await db.find("receipts", { action: "approve" }))).toEqual([
      "r1",
    ]);
    expect(await db.count("receipts", { action: "approve" })).toBe(1);
  });

  it("counts from the index, and by opening when the index only bounds", async () => {
    await seed();
    expect(await db.count("receipts", { action: "approve" })).toBe(2);
    expect(await db.count("receipts", { userId: "user-alice" })).toBe(2);
    expect(await db.count("sessions", { userId: "user-alice" })).toBe(1);
    expect(await db.count("receipts")).toBe(3);
  });

  it("combines predicates, and indexes rows written after a layer is built", async () => {
    await seed();
    await db.find("receipts", { userId: "user-alice" });
    await db.put(
      "receipts",
      receipt("r4", "user-alice", "2026-04-01T00:00:00Z", { action: "deny" }),
    );
    expect(
      ids(await db.find("receipts", { userId: "user-alice", action: "deny" })),
    ).toEqual(["r4"]);
    expect(ids(await db.find("receipts", { userId: "user-alice" }))).toEqual([
      "r1",
      "r3",
      "r4",
    ]);
  });

  it("forgets a row's entries when it changes or goes", async () => {
    await seed();
    expect(ids(await db.find("receipts", { action: "deny" }))).toEqual(["r2"]);
    await db.put("receipts", receipt("r2", "user-bob", "2026-02-01T00:00:00Z"));
    expect(await db.find("receipts", { action: "deny" })).toEqual([]);
    await db.delete("receipts", "r1");
    expect(ids(await db.find("receipts", { tags: "vault" }))).toEqual(["r3"]);
  });

  it("refuses a column with no such layer", async () => {
    await expect(db.find("receipts", { note: "x" })).rejects.toThrow(
      /no eq layer/,
    );
    await expect(db.find("receipts", { nope: "x" })).rejects.toThrow(
      /no column/,
    );
  });
});

describe("order", () => {
  it("answers ranges over times and integers", async () => {
    await seed();
    expect(
      ids(await db.find("receipts", { at: { gte: "2026-02-01T00:00:00Z" } })),
    ).toEqual(["r2", "r3"]);
    expect(
      ids(await db.find("receipts", { at: { gt: "2026-02-01T00:00:00Z" } })),
    ).toEqual(["r3"]);
    expect(
      ids(await db.find("receipts", { at: { lt: "2026-02-01T00:00:00Z" } })),
    ).toEqual(["r1"]);
    expect(
      ids(await db.find("receipts", { amount: { gte: 10, lte: 60 } })),
    ).toEqual(["r3"]);
    expect(await db.find("receipts", { amount: { gt: 100 } })).toEqual([]);
    expect(await db.find("receipts", { amount: { gte: 2_000_000 } })).toEqual(
      [],
    );
    expect(ids(await db.find("receipts", { amount: { gte: -50 } }))).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
  });

  it("pages by order without opening the rest", async () => {
    await seed();
    const latest = await db.find(
      "receipts",
      {},
      { order: { column: "at", direction: "desc" }, limit: 2 },
    );
    expect(latest.map((row) => row.id)).toEqual(["r3", "r2"]);
    const earliest = await db.find(
      "receipts",
      {},
      { order: { column: "at" }, limit: 1 },
    );
    expect(earliest.map((row) => row.id)).toEqual(["r1"]);
  });

  it("sorts another predicate's rows, and filters an ordered walk", async () => {
    await seed();
    const mine = await db.find(
      "receipts",
      { userId: "user-alice" },
      { order: { column: "amount", direction: "desc" } },
    );
    expect(mine.map((row) => row.id)).toEqual(["r1", "r3"]);
    const recentVault = await db.find(
      "receipts",
      { at: { gte: "2026-02-01T00:00:00Z" }, tags: "vault" },
      { order: { column: "at", direction: "asc" } },
    );
    expect(recentVault.map((row) => row.id)).toEqual(["r3"]);
  });

  it("does not leak one column's order into another's", async () => {
    await seed();
    await db.find("receipts", {}, { order: { column: "amount" } });
    await db.find("receipts", {}, { order: { column: "at" } });
    const byAmount = await db.find("receipts", { amount: { lte: 10 } });
    expect(ids(byAmount)).toEqual(["r2"]);
  });

  it("needs an order layer to sort by", async () => {
    await expect(
      db.find("receipts", {}, { order: { column: "action" } }),
    ).rejects.toThrow(/no order layer/);
  });
});

describe("keywords", () => {
  it("finds whole words, any case, and requires every word asked for", async () => {
    await seed();
    expect(ids(await db.find("receipts", { note: { word: "VAULT" } }))).toEqual(
      ["r1", "r3"],
    );
    expect(
      ids(await db.find("receipts", { note: { word: "vault rotation" } })),
    ).toEqual(["r3"]);
    expect(await db.find("receipts", { note: { word: "vaul" } })).toEqual([]);
  });

  it("finds by prefix from the shortest indexed length", async () => {
    await seed();
    expect(ids(await db.find("receipts", { note: { prefix: "rot" } }))).toEqual(
      ["r3"],
    );
    expect(
      ids(await db.find("receipts", { note: { prefix: "Quart" } })),
    ).toEqual(["r1"]);
    await expect(
      db.find("receipts", { note: { prefix: "ro" } }),
    ).rejects.toThrow(/at least 3/);
    expect(
      ids(
        await db.find("receipts", { note: { prefix: "quarterlyvaultreview" } }),
      ),
    ).toEqual([]);
  });
});

describe("layers", () => {
  it("builds on demand, once, over rows that were already there", async () => {
    await seed();
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
    await seed();
    await db.destroy();
    db = await openEncryptedDb("receipts-test", receiptSchema);
    expect(await db.size()).toBe(0);
    expect(await db.find("receipts", { action: "deny" })).toEqual([]);
  });
});

describe("keys", () => {
  it("opens nothing written under another device key", async () => {
    await seed();
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

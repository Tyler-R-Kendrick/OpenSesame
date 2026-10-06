import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetAtRestKeyForTest } from "../at-rest/key.js";
import { type EncryptedDb, openEncryptedDb } from "./db.js";
import {
  freshIndexedDb,
  ids,
  receipt,
  receiptSchema,
  seed,
} from "./edb.test-support.js";

let db: EncryptedDb;

beforeEach(async () => {
  freshIndexedDb();
  db = await openEncryptedDb("receipts-test", receiptSchema);
});

afterEach(() => {
  db.close();
  forgetAtRestKeyForTest();
});

describe("equality", () => {
  it("finds rows by a value without opening the others", async () => {
    await seed(db);
    expect(ids(await db.find("receipts", { action: "deny" }))).toEqual(["r2"]);
    expect(await db.find("receipts", { action: "nothing" })).toEqual([]);
  });

  it("finds an element of an array column", async () => {
    await seed(db);
    expect(ids(await db.find("receipts", { tags: "vault" }))).toEqual([
      "r1",
      "r3",
    ]);
    expect(ids(await db.find("receipts", { tags: "review" }))).toEqual(["r1"]);
  });

  it("joins a group across tables and keeps each table's rows apart", async () => {
    await seed(db);
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
    await seed(db);
    expect(await db.count("receipts", { action: "approve" })).toBe(2);
    expect(await db.count("receipts", { userId: "user-alice" })).toBe(2);
    expect(await db.count("sessions", { userId: "user-alice" })).toBe(1);
    expect(await db.count("receipts")).toBe(3);
  });

  it("combines predicates, and indexes rows written after a layer is built", async () => {
    await seed(db);
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
    await seed(db);
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
    await seed(db);
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
    await seed(db);
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
    await seed(db);
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
    await seed(db);
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
    await seed(db);
    expect(ids(await db.find("receipts", { note: { word: "VAULT" } }))).toEqual(
      ["r1", "r3"],
    );
    expect(
      ids(await db.find("receipts", { note: { word: "vault rotation" } })),
    ).toEqual(["r3"]);
    expect(await db.find("receipts", { note: { word: "vaul" } })).toEqual([]);
  });

  it("finds by prefix from the shortest indexed length", async () => {
    await seed(db);
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

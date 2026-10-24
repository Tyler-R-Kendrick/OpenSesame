import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import {
  ACCOUNTS,
  ENTRIES,
  legacyHistoryStore,
  resetLegacyHistorySweep,
} from "./history-backup-legacy.js";

type Callback = () => void;
type Row = JsonObject;
type FakeDatabase = { transaction(): FakeTransaction; close(): void };
type FakeRequest = {
  onsuccess?: Callback;
  onerror?: Callback;
  onupgradeneeded?: Callback;
  result?: FakeDatabase;
  error?: Error;
};
type FakeListing = { onsuccess?: Callback; result: Row[] };
type FakeStore = { getAll(): FakeListing; put(row: Row): FakeRequest };
type FakeTransaction = {
  oncomplete: Callback | null;
  onabort: Callback | null;
  onerror: Callback | null;
  error: Error | null;
  objectStore(name: string): FakeStore;
};

function fakeIndexedDb() {
  const rows = new Map<string, Row[]>([
    [
      ACCOUNTS,
      [
        {
          id: "acct_1",
          providerId: "github",
          anonToken: "token",
          claimState: "provisional",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    ],
    [ENTRIES, []],
  ]);
  let failNextPut = true;
  const store = (tx: FakeTransaction, name: string): FakeStore => ({
    getAll: () => {
      const listed: FakeListing = { result: rows.get(name) ?? [] };
      queueMicrotask(() => listed.onsuccess?.());
      return listed;
    },
    put: (row) => {
      const request: FakeRequest = {};
      if (failNextPut) {
        failNextPut = false;
        setTimeout(() => {
          request.error = new Error("transient");
          request.onerror?.();
          tx.error = new Error("transient");
          tx.onerror?.();
        }, 0);
        return request;
      }
      rows.set(name, [
        ...(rows.get(name) ?? []).filter((entry) => entry.id !== row.id),
        row,
      ]);
      queueMicrotask(() => request.onsuccess?.());
      setTimeout(() => tx.oncomplete?.(), 0);
      return request;
    },
  });
  return {
    rows,
    factory: () => ({
      open: () => {
        const request: FakeRequest = {};
        const tx: FakeTransaction = {
          oncomplete: null,
          onabort: null,
          onerror: null,
          error: null,
          objectStore: (name) => store(tx, name),
        };
        request.result = { transaction: () => tx, close: () => undefined };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    }),
  };
}

beforeEach(() => {
  resetLegacyHistorySweep();
});

afterEach(() => {
  resetLegacyHistorySweep();
  configureHost(createTestHost());
});

describe("legacy history plaintext sweep", () => {
  it("retries after a failed seal and latches only once the swap succeeded", async () => {
    const db = fakeIndexedDb();
    // The fake carries the members the legacy sweep calls.
    const indexedDB: IDBFactory = overlapCast(db.factory());
    configureHost(createTestHost({ indexedDB }));
    // The failed sweep falls back to memory instead of rejecting the read.
    await expect(legacyHistoryStore.listAccounts()).resolves.toBeUndefined();
    expect(db.rows.get(ACCOUNTS)?.[0]?.sealed).toBeUndefined();

    const accounts = await legacyHistoryStore.listAccounts();
    expect(accounts?.map((row) => row.id)).toEqual(["acct_1"]);
    expect(db.rows.get(ACCOUNTS)?.[0]?.sealed).toEqual(expect.any(String));
  });
});

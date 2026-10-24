import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import {
  ACCOUNTS,
  ENTRIES,
  legacyHistoryStore,
  resetLegacyHistorySweep,
} from "./history-backup-legacy.js";

type Row = Record<string, unknown>;

function fakeIndexedDb() {
  const rows: Record<string, Row[]> = {
    [ACCOUNTS]: [
      {
        id: "acct_1",
        providerId: "github",
        anonToken: "token",
        claimState: "provisional",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    [ENTRIES]: [],
  };
  let failNextPut = true;
  return {
    rows,
    factory: () => ({
      open: () => {
        const request: {
          onsuccess?: () => void;
          onerror?: () => void;
          onupgradeneeded?: () => void;
          result?: unknown;
        } = {};
        const tx = {
          oncomplete: null as null | (() => void),
          onabort: null as null | (() => void),
          onerror: null as null | (() => void),
          error: null as null | Error,
          objectStore(name: string) {
            return {
              getAll: () => {
                const listed: { onsuccess?: () => void; result: Row[] } = {
                  result: rows[name] ?? [],
                };
                queueMicrotask(() => listed.onsuccess?.());
                return listed;
              },
              put: (row: Row) => {
                const request: {
                  onsuccess?: () => void;
                  onerror?: () => void;
                  error?: Error;
                } = {};
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
                rows[name] = [
                  ...(rows[name] ?? []).filter((entry) => entry.id !== row.id),
                  row,
                ];
                queueMicrotask(() => request.onsuccess?.());
                setTimeout(() => tx.oncomplete?.(), 0);
                return request;
              },
            };
          },
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
    configureHost(
      createTestHost({ indexedDB: overlapCast(db.factory()) as IDBFactory }),
    );
    // The failed sweep falls back to memory instead of rejecting the read.
    await expect(legacyHistoryStore.listAccounts()).resolves.toBeUndefined();
    expect(db.rows[ACCOUNTS]?.[0]?.sealed).toBeUndefined();

    const accounts = await legacyHistoryStore.listAccounts();
    expect(accounts?.map((row) => row.id)).toEqual(["acct_1"]);
    expect(db.rows[ACCOUNTS]?.[0]?.sealed).toEqual(expect.any(String));
  });
});

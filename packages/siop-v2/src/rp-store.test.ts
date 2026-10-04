import { describe, expect, it } from "vitest";
import {
  type LoginStorage,
  MemoryLoginStore,
  MemoryReplayLedger,
  type PendingSiopLogin,
  StorageLoginStore,
} from "./rp-store.js";

const LOGIN: PendingSiopLogin = {
  clientId: "local_00000000-0000-4000-8000-000000000001",
  nonce: "n",
  redirectUri: "https://rp.example/callback",
  createdAtMs: 1_000,
  attempts: 0,
};

function memoryStorage(): LoginStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

describe("MemoryLoginStore", () => {
  it("hands a login to exactly one taker", () => {
    const store = new MemoryLoginStore();
    store.put("s", LOGIN);
    expect(store.take("s")).toEqual(LOGIN);
    expect(store.take("s")).toBeUndefined();
  });

  it("drops logins older than its lifetime when another arrives", () => {
    const store = new MemoryLoginStore(100, 1_000);
    store.put("old", LOGIN);
    store.put("new", { ...LOGIN, createdAtMs: 5_000 });
    expect(store.size).toBe(1);
    expect(store.take("old")).toBeUndefined();
  });

  it("never holds more than its bound", () => {
    const store = new MemoryLoginStore(2);
    for (const state of ["a", "b", "c"]) {
      store.put(state, LOGIN);
    }
    expect(store.size).toBe(2);
    expect(store.take("a")).toBeUndefined();
  });
});

describe("MemoryReplayLedger", () => {
  it("records a key once until it expires", () => {
    const ledger = new MemoryReplayLedger();
    expect(ledger.claim("k", 2_000, 1_000)).toBe(true);
    expect(ledger.has("k", 1_500)).toBe(true);
    expect(ledger.claim("k", 2_000, 1_500)).toBe(false);
    expect(ledger.has("k", 2_000)).toBe(false);
    expect(ledger.claim("k", 3_000, 2_000)).toBe(true);
  });

  it("has() never records", () => {
    const ledger = new MemoryReplayLedger();
    expect(ledger.has("unseen", 0)).toBe(false);
    expect(ledger.size).toBe(0);
  });

  it("never holds more than its bound", () => {
    const ledger = new MemoryReplayLedger(2);
    ledger.claim("a", 10_000, 0);
    ledger.claim("b", 10_000, 0);
    ledger.claim("c", 10_000, 0);
    expect(ledger.size).toBe(2);
    expect(ledger.has("a", 0)).toBe(false);
    expect(ledger.has("c", 0)).toBe(true);
  });
});

describe("StorageLoginStore", () => {
  it("round-trips a login and removes it on take", () => {
    const storage = memoryStorage();
    const store = new StorageLoginStore(storage);
    store.put("s", LOGIN);
    expect(storage.entries.size).toBe(1);
    expect(store.take("s")).toEqual(LOGIN);
    expect(storage.entries.size).toBe(0);
    expect(store.take("s")).toBeUndefined();
  });

  it("treats a corrupted or foreign entry as no login, and still removes it", () => {
    const storage = memoryStorage();
    const store = new StorageLoginStore(storage);
    storage.setItem("siop-rp:login:bad", "{not json");
    expect(store.take("bad")).toBeUndefined();
    storage.setItem(
      "siop-rp:login:wrong-types",
      JSON.stringify({
        nonce: 1,
        redirectUri: "x",
        createdAtMs: "y",
        attempts: 0,
      }),
    );
    expect(store.take("wrong-types")).toBeUndefined();
    storage.setItem("siop-rp:login:partial", JSON.stringify({ nonce: "n" }));
    storage.setItem(
      "siop-rp:login:no-client",
      JSON.stringify({
        nonce: "n",
        redirectUri: "https://rp.example/callback",
        createdAtMs: 1,
        attempts: 0,
      }),
    );
    expect(store.take("no-client")).toBeUndefined();
    expect(store.take("partial")).toBeUndefined();
    expect(storage.entries.size).toBe(0);
  });
});

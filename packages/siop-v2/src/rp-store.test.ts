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
  binding: "browser-secret",
  nonce: "n",
  redirectUri: "https://rp.example/callback",
  createdAtMs: 1_000,
  attempts: 0,
};

function memoryStorage(): LoginStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
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
    expect(store.put("s", LOGIN)).toBe(true);
    expect(store.take("s")).toEqual(LOGIN);
    expect(store.take("s")).toBeUndefined();
  });

  it("drops logins older than its lifetime when another arrives", () => {
    const store = new MemoryLoginStore(100, 1_000, () => 5_000);
    store.put("old", LOGIN);
    store.put("new", { ...LOGIN, createdAtMs: 5_000 });
    expect(store.size).toBe(1);
    expect(store.take("old")).toBeUndefined();
  });

  it("refuses at its bound instead of evicting a live login", () => {
    const store = new MemoryLoginStore(2, 60_000, () => 1_000);
    expect(store.put("a", LOGIN)).toBe(true);
    expect(store.put("b", LOGIN)).toBe(true);
    expect(store.put("c", LOGIN)).toBe(false);
    expect(store.size).toBe(2);
    expect(store.take("a")).toEqual(LOGIN);
    expect(store.put("c", LOGIN)).toBe(true);
  });

  it("lets a login that was taken come back when it is put again", () => {
    const store = new MemoryLoginStore(1, 60_000, () => 1_000);
    store.put("a", LOGIN);
    const taken = store.take("a");
    expect(taken).toBeDefined();
    expect(store.put("a", { ...LOGIN, attempts: 1 })).toBe(true);
    expect(store.take("a")?.attempts).toBe(1);
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
    expect(store.put("s", LOGIN)).toBe(true);
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
    expect(store.take("partial")).toBeUndefined();
    for (const missing of ["clientId", "binding"]) {
      const rest = Object.fromEntries(
        Object.entries(LOGIN).filter(([key]) => key !== missing),
      );
      storage.setItem(`siop-rp:login:no-${missing}`, JSON.stringify(rest));
      expect(store.take(`no-${missing}`)).toBeUndefined();
    }
    expect(storage.entries.size).toBe(0);
  });

  it("sweeps entries it cannot read when it makes room", () => {
    const storage = memoryStorage();
    const store = new StorageLoginStore(storage, 2, 60_000, () => 1_000);
    storage.setItem("siop-rp:login:junk", "{broken");
    expect(store.put("a", LOGIN)).toBe(true);
    expect(storage.entries.has("siop-rp:login:junk")).toBe(false);
  });
});

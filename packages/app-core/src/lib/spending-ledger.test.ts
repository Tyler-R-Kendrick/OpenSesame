/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSpendingLedgerStorage,
  createBudget,
  formatUnits,
  getSpendingLedger,
  listBudgetRows,
  removeBudget,
  resetSpendingLedgerCache,
  updateBudget,
} from "./spending-ledger.js";

/** Node 22 shadows Storage with an unavailable experimental global. */
function ensureLocalStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
  } satisfies Storage);
}

function openSharedTree(): void {
  getSpendingLedger().transact((tx) => {
    tx.openNode({
      nodeId: "household",
      ceiling: 1000n,
      strategy: "shared_counter",
    });
    tx.openNode({
      nodeId: "child-a",
      parentId: "household",
      ceiling: 0n,
      strategy: "shared_counter",
    });
    tx.openNode({
      nodeId: "child-b",
      parentId: "household",
      ceiling: 0n,
      strategy: "shared_counter",
    });
  });
}

describe("spending-ledger", () => {
  beforeEach(() => {
    ensureLocalStorage();
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
  });

  afterEach(() => {
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
  });

  it("adds, edits, and removes a named budget", () => {
    const created = createBudget({ name: " Groceries ", ceiling: 250n });
    expect(created.label).toBe("Groceries");
    expect(created.ceiling).toBe(250n);
    expect(listBudgetRows().map((row) => row.label)).toEqual(["Groceries"]);

    const edited = updateBudget({
      nodeId: created.nodeId,
      name: "Kitchen",
      ceiling: 400n,
    });
    expect(edited.label).toBe("Kitchen");
    expect(edited.locallyAvailable).toBe(400n);

    resetSpendingLedgerCache();
    const after = listBudgetRows(getSpendingLedger());
    expect(after).toHaveLength(1);
    expect(after[0]?.label).toBe("Kitchen");
    expect(after[0]?.ceiling).toBe(400n);

    removeBudget(created.nodeId);
    expect(listBudgetRows()).toEqual([]);
  });

  it("persists a shared tree across cache reset (WAL-D07)", () => {
    openSharedTree();
    const before = getSpendingLedger().listNodes();
    expect(before.map((r) => r.nodeId).sort()).toEqual([
      "child-a",
      "child-b",
      "household",
    ]);
    expect(listBudgetRows().map((r) => r.nodeId)).toEqual(["household"]);
    const root = before.find((r) => r.nodeId === "household");
    expect(root?.ceiling).toBe(1000n);
    expect(root?.locallyAvailable).toBe(1000n);

    resetSpendingLedgerCache();
    const after = getSpendingLedger().listNodes();
    expect(after.map((r) => r.nodeId).sort()).toEqual([
      "child-a",
      "child-b",
      "household",
    ]);
    expect(after.find((r) => r.nodeId === "household")?.ceiling).toBe(1000n);
  });

  it("refuses the second sibling when shared remainder is insufficient (WAL-D03)", () => {
    openSharedTree();
    const ledger = getSpendingLedger();
    ledger.reserve({
      attemptId: `demo-a-${Date.now()}`,
      nodeId: "child-a",
      amount: 700n,
    });
    expect(() =>
      ledger.reserve({
        attemptId: `demo-b-${Date.now()}`,
        nodeId: "child-b",
        amount: 400n,
      }),
    ).toThrow();

    const root = ledger.project("household");
    expect(root).toBeDefined();
    if (root === undefined) return;
    expect(root.locallyAvailable).toBe(300n);
    expect(root.reservedToChildren).toBe(700n);
    expect(root.ceiling).toBe(
      root.postedSpending +
        root.unresolvedExternalExposure +
        root.reservedToChildren +
        root.locallyAvailable,
    );
  });

  it("formats subunits without float coercion (WAL-D01)", () => {
    expect(formatUnits(0n)).toBe("0");
    expect(formatUnits(1000n)).toBe("1000");
    expect(formatUnits(1234567n, 6)).toBe("1.234567");
    expect(formatUnits(1n, 2)).toBe("0.01");
  });

  it("rejects corrupt storage without inventing balances", () => {
    localStorage.setItem("opensesame.wallet.budget.v1", "{not-json");
    resetSpendingLedgerCache();
    expect(listBudgetRows(getSpendingLedger())).toEqual([]);
  });
  it("localStorage tamper changes local projection only (WAL-D08)", () => {
    openSharedTree();
    const before = getSpendingLedger().project("household");
    expect(before).toBeDefined();
    const raw = localStorage.getItem("opensesame.wallet.budget.v1.personal");
    expect(raw).toBeTruthy();
    localStorage.setItem(
      "opensesame.wallet.budget.v1.personal",
      JSON.stringify({ version: 1, journal: [], nodes: [], attempts: [] }),
    );
    resetSpendingLedgerCache();
    const after = getSpendingLedger().project("household");
    expect(after).toBeUndefined();
  });

  it("keeps in-memory ledger when localStorage write fails (WAL-D17)", () => {
    openSharedTree();
    const before = getSpendingLedger().project("household");
    expect(before).toBeDefined();
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
      clear: () => map.clear(),
      get length() {
        return map.size;
      },
      key: (index: number) => [...map.keys()][index] ?? null,
    } satisfies Storage);
    resetSpendingLedgerCache();
    expect(() =>
      getSpendingLedger().openNode({
        nodeId: "household",
        ceiling: 1000n,
        strategy: "shared_counter",
      }),
    ).not.toThrow();
    const row = getSpendingLedger().project("household");
    expect(row).toBeDefined();
  });

  it("shared root refuses reuse after committed spend (WAL-D11)", () => {
    openSharedTree();
    const ledger = getSpendingLedger();
    ledger.reserve({ attemptId: "x402-path", nodeId: "child-a", amount: 900n });
    ledger.commit("x402-path");
    expect(() =>
      ledger.reserve({
        attemptId: "other-adapter-path",
        nodeId: "child-b",
        amount: 200n,
      }),
    ).toThrow();
    expect(ledger.project("household")?.locallyAvailable).toBe(100n);
  });
});

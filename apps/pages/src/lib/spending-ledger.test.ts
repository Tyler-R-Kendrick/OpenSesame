/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSpendingLedgerStorage,
  formatUnits,
  getSpendingLedger,
  listBudgetRows,
  openDemoHouseholdBudget,
  resetSpendingLedgerCache,
  trySiblingOverspendDemo,
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

  it("persists a household budget across cache reset (WAL-D07)", () => {
    openDemoHouseholdBudget();
    const before = listBudgetRows();
    expect(before.map((r) => r.nodeId).sort()).toEqual([
      "child-a",
      "child-b",
      "household",
    ]);
    const root = before.find((r) => r.nodeId === "household");
    expect(root?.ceiling).toBe(1000n);
    expect(root?.locallyAvailable).toBe(1000n);

    resetSpendingLedgerCache();
    const after = listBudgetRows(getSpendingLedger());
    expect(after.map((r) => r.nodeId).sort()).toEqual([
      "child-a",
      "child-b",
      "household",
    ]);
    expect(after.find((r) => r.nodeId === "household")?.ceiling).toBe(1000n);
  });

  it("refuses the second sibling when shared remainder is insufficient (WAL-D03)", () => {
    const result = trySiblingOverspendDemo();
    expect(result.firstOk).toBe(true);
    expect(result.secondOk).toBe(false);

    const root = getSpendingLedger().project("household");
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
    openDemoHouseholdBudget();
    const before = getSpendingLedger().project("household");
    expect(before).toBeDefined();
    const raw = localStorage.getItem("opensesame.wallet.budget.v1");
    expect(raw).toBeTruthy();
    // Hostile same-origin edit — local mode does not claim resistance.
    localStorage.setItem(
      "opensesame.wallet.budget.v1",
      JSON.stringify({ version: 1, journal: [], nodes: [], attempts: [] }),
    );
    resetSpendingLedgerCache();
    const after = getSpendingLedger().project("household");
    expect(after).toBeUndefined();
    // Independent enforcement is out of scope for this local ledger.
  });

  it("keeps in-memory ledger when localStorage write fails (WAL-D17)", () => {
    openDemoHouseholdBudget();
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
    // Re-open after cache reset with failing persistence — must not invent success.
    expect(() => openDemoHouseholdBudget()).not.toThrow();
    const row = getSpendingLedger().project("household");
    expect(row).toBeDefined();
  });

  it("shared root refuses reuse after committed spend (WAL-D11)", () => {
    openDemoHouseholdBudget();
    const ledger = getSpendingLedger();
    ledger.reserve({ attemptId: "x402-path", nodeId: "child-a", amount: 900n });
    ledger.commit("x402-path");
    // Second adapter path against the same conserved root must see remaining only.
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

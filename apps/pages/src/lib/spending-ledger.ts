/**
 * Browser-local conserved spending ledger (ADR 0123).
 *
 * Wraps `@opensesame/wallet-budget` with localStorage persistence. Same-origin
 * only — not a hostile-owner or cross-device money counter. Amounts are exact
 * integer subunits (bigint), never floats.
 */

import {
  type AmountUnits,
  type BudgetLedger,
  type BudgetProjection,
  type BudgetSnapshot,
  type BudgetStore,
  type BudgetTx,
  createBudgetLedger,
  createInMemoryBudgetStore,
} from "@opensesame/wallet-budget";
import {
  SPENDING_LEDGER_STORAGE_KEY,
  readPersisted,
  writePersisted,
} from "./spending-ledger-persist.js";

/**
 * Persist after every successful transaction. Nested transactions stay in the
 * inner store; only the outer publish hits localStorage.
 */
class PersistingBudgetStore implements BudgetStore {
  private readonly inner: BudgetStore;

  constructor(initial?: BudgetSnapshot) {
    this.inner = createInMemoryBudgetStore(initial);
  }

  transact<T>(body: (tx: BudgetTx) => T): T {
    const result = this.inner.transact(body);
    writePersisted(this.inner.snapshot());
    return result;
  }

  snapshot(): BudgetSnapshot {
    return this.inner.snapshot();
  }
}

let cached: BudgetLedger | null = null;

export function getSpendingLedger(): BudgetLedger {
  if (cached !== null) return cached;
  cached = createBudgetLedger(new PersistingBudgetStore(readPersisted()));
  return cached;
}

/** Test seam: drop the process cache (does not clear storage). */
export function resetSpendingLedgerCache(): void {
  cached = null;
}

export function clearSpendingLedgerStorage(): void {
  try {
    localStorage.removeItem(SPENDING_LEDGER_STORAGE_KEY);
  } catch {
    // Ignore missing Storage (SSR / Node without stub).
  }
  cached = null;
}

export function formatUnits(amount: AmountUnits, decimals = 0): string {
  if (decimals === 0) return amount.toString(10);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const fracText = frac.toString(10).padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole.toString(10)}.${fracText}`;
}

export type BudgetRow = BudgetProjection & {
  readonly label: string;
};

export function listBudgetRows(
  ledger: BudgetLedger = getSpendingLedger(),
): readonly BudgetRow[] {
  return ledger.listNodes().map((node) => ({
    ...node,
    label:
      node.parentId === null ? "Root budget" : `Allocation · ${node.nodeId}`,
  }));
}

export function openDemoHouseholdBudget(
  ledger: BudgetLedger = getSpendingLedger(),
): void {
  const existing = ledger.project("household");
  if (existing !== undefined) return;
  ledger.transact((tx) => {
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

export type SiblingOverspendDemoResult = {
  readonly firstOk: boolean;
  readonly secondOk: boolean;
};

/** Demo: siblings cannot both reserve more than the shared remainder (WAL-D03). */
export function trySiblingOverspendDemo(
  ledger: BudgetLedger = getSpendingLedger(),
): SiblingOverspendDemoResult {
  openDemoHouseholdBudget(ledger);
  let firstOk = true;
  let secondOk = true;
  try {
    ledger.reserve({
      attemptId: `demo-a-${Date.now()}`,
      nodeId: "child-a",
      amount: 700n,
    });
  } catch {
    firstOk = false;
  }
  try {
    ledger.reserve({
      attemptId: `demo-b-${Date.now()}`,
      nodeId: "child-b",
      amount: 400n,
    });
  } catch {
    secondOk = false;
  }
  return { firstOk, secondOk } satisfies SiblingOverspendDemoResult;
}

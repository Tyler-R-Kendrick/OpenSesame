/**
 * Browser-local conserved spending ledger (ADR 0123).
 *
 * Wraps `@opensesame/wallet-budget` with localStorage persistence. Same-origin
 * only — not a hostile-owner or cross-device money counter. Amounts are exact
 * integer subunits (bigint), never floats.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type AmountUnits,
  BudgetError,
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
import { unbindBudget } from "./wallet-assignments.js";
import {
  onWalletTombChange,
  walletStorageKey,
  walletStorageTomb,
} from "./wallet-storage-scope.js";

const LABELS_KEY = "opensesame.wallet.budget.labels.v1";

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
let cachedTomb = "";
let labelCache: Record<string, string> | null = null;

onWalletTombChange(() => {
  cached = null;
  cachedTomb = "";
  labelCache = null;
});

export function getSpendingLedger(): BudgetLedger {
  const tomb = walletStorageTomb();
  if (cached !== null && cachedTomb === tomb) return cached;
  cachedTomb = tomb;
  cached = createBudgetLedger(new PersistingBudgetStore(readPersisted()));
  return cached;
}

/** Test seam: drop the process cache (does not clear storage). */
export function resetSpendingLedgerCache(): void {
  cached = null;
}

export function clearSpendingLedgerStorage(): void {
  try {
    localStorage.removeItem(walletStorageKey(SPENDING_LEDGER_STORAGE_KEY));
    localStorage.removeItem(walletStorageKey(LABELS_KEY));
    if (walletStorageTomb() === "personal") {
      localStorage.removeItem(SPENDING_LEDGER_STORAGE_KEY);
      localStorage.removeItem(LABELS_KEY);
    }
  } catch {
    // Ignore missing Storage (SSR / Node without stub).
  }
  cached = null;
  cachedTomb = "";
  labelCache = null;
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

function readLabels(): Record<string, string> {
  if (labelCache !== null) return labelCache;
  try {
    let raw = localStorage.getItem(walletStorageKey(LABELS_KEY));
    if ((raw === null || raw === "") && walletStorageTomb() === "personal") {
      raw = localStorage.getItem(LABELS_KEY);
    }
    if (raw === null || raw === "") {
      labelCache = {};
      return labelCache;
    }
    const parsed: BoundaryValue = overlapCast(JSON.parse(raw));
    if (!isJsonObject(parsed)) {
      labelCache = {};
      return labelCache;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isString(value) && value.trim() !== "") out[key] = value;
    }
    labelCache = out;
    return labelCache;
  } catch {
    labelCache = {};
    return labelCache;
  }
}

function writeLabels(labels: Record<string, string>): void {
  labelCache = labels;
  try {
    localStorage.setItem(walletStorageKey(LABELS_KEY), JSON.stringify(labels));
  } catch {
    // Quota / private mode — keep the in-memory labels.
  }
}

function setLabel(nodeId: string, name: string): void {
  const labels = readLabels();
  labels[nodeId] = name;
  writeLabels(labels);
}

function dropLabel(nodeId: string): void {
  const labels = readLabels();
  delete labels[nodeId];
  writeLabels(labels);
}

export function listBudgetRows(
  ledger: BudgetLedger = getSpendingLedger(),
): readonly BudgetRow[] {
  const labels = readLabels();
  return ledger
    .listNodes()
    .filter((node) => node.parentId === null)
    .map((node) => ({
      ...node,
      label: labels[node.nodeId] ?? node.nodeId,
    }));
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("Name a budget.");
  return trimmed;
}

export function parseCeiling(raw: string): AmountUnits {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/u.test(trimmed)) {
    throw new Error("Ceiling must be a non-negative integer.");
  }
  return BigInt(trimmed);
}

export function createBudget(input: {
  readonly name: string;
  readonly ceiling: AmountUnits;
}): BudgetRow {
  const name = requireName(input.name);
  const nodeId = `b-${crypto.randomUUID()}`;
  const node = getSpendingLedger().openNode({
    nodeId,
    ceiling: input.ceiling,
    strategy: "shared_counter",
  });
  setLabel(nodeId, name);
  return { ...node, label: name };
}

export function updateBudget(input: {
  readonly nodeId: string;
  readonly name: string;
  readonly ceiling: AmountUnits;
}): BudgetRow {
  const name = requireName(input.name);
  const ledger = getSpendingLedger();
  const current = ledger.project(input.nodeId);
  const node =
    current !== undefined && current.ceiling === input.ceiling
      ? current
      : ledger.setCeiling({
          nodeId: input.nodeId,
          ceiling: input.ceiling,
        });
  setLabel(input.nodeId, name);
  return { ...node, label: name };
}

export function removeBudget(nodeId: string): void {
  getSpendingLedger().closeNode(nodeId);
  dropLabel(nodeId);
  unbindBudget(nodeId);
}

export { BudgetError };

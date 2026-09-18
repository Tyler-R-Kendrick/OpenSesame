/**
 * Which vault payment instrument is bound to which budget node.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  onWalletTombChange,
  walletStorageKey,
} from "./wallet-storage-scope.js";

const STORAGE_KEY = "opensesame.wallet.instrument-budgets.v1";

let cache: Record<string, string> | null = null;

onWalletTombChange(() => {
  cache = null;
});

function assignmentKey(): string {
  return walletStorageKey(STORAGE_KEY);
}

function readAll(): Record<string, string> {
  if (cache !== null) return cache;
  try {
    const raw = localStorage.getItem(assignmentKey());
    if (raw === null || raw === "") {
      cache = {};
      return cache;
    }
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) {
      cache = {};
      return cache;
    }
    const out: Record<string, string> = {};
    for (const [itemId, budgetId] of Object.entries(parsed)) {
      if (isString(budgetId) && budgetId !== "") out[itemId] = budgetId;
    }
    cache = out;
    return cache;
  } catch {
    cache = {};
    return cache;
  }
}

function persistCache(): void {
  if (cache === null) return;
  try {
    localStorage.setItem(assignmentKey(), JSON.stringify(cache));
  } catch {
    // Keep memory copy if storage is unavailable.
  }
}

export function budgetIdForInstrument(itemId: string): string | null {
  return readAll()[itemId] ?? null;
}

export function instrumentIdsForBudget(budgetId: string): readonly string[] {
  return Object.entries(readAll())
    .filter(([, bound]) => bound === budgetId)
    .map(([itemId]) => itemId);
}

export function assignInstrumentBudget(
  itemId: string,
  budgetId: string | null,
): void {
  const next = { ...readAll() };
  if (budgetId === null || budgetId === "") delete next[itemId];
  else next[itemId] = budgetId;
  cache = next;
  persistCache();
}

export function setBudgetInstruments(
  budgetId: string,
  itemIds: readonly string[],
): void {
  const next = { ...readAll() };
  for (const [itemId, bound] of Object.entries(next)) {
    if (bound === budgetId) delete next[itemId];
  }
  for (const itemId of itemIds) next[itemId] = budgetId;
  cache = next;
  persistCache();
}

export function unbindBudget(budgetId: string): void {
  setBudgetInstruments(budgetId, []);
}

export function clearInstrumentBudgets(): void {
  cache = {};
  try {
    localStorage.removeItem(assignmentKey());
  } catch {
    // ignore
  }
}

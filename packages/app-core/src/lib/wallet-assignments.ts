/**
 * Which vault payment instrument is bound to which budget node.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { localStore } from "../ports.js";
import {
  onWalletTombChange,
  walletStorageKey,
  walletStorageScope,
  walletStorageTomb,
} from "./wallet-storage-scope.js";

const STORAGE_KEY = "opensesame.wallet.instrument-budgets.v1";

let cache: Record<string, string> | null = null;
let cacheScope = -1;

/**
 * Follow the active tomb: a switch drops the process cache so a guest never
 * reads the personal vault's instrument bindings. Subscribed by the
 * `wallet.spending` runtime while it is active (never at import), and the
 * cache is keyed by the scope epoch as well, so a read after an unobserved
 * switch still misses.
 */
export function watchWalletAssignmentScope(): () => void {
  return onWalletTombChange(() => {
    cache = null;
    cacheScope = -1;
  });
}

/** Remember `next` against the scope it was read or written in. */
function cacheAll(next: Record<string, string>): Record<string, string> {
  const scope = walletStorageScope();
  cache = next;
  cacheScope = scope;
  return next;
}

function assignmentKey(): string {
  return walletStorageKey(STORAGE_KEY);
}

function readAll(): Record<string, string> {
  const scope = walletStorageScope();
  if (cache !== null && cacheScope === scope) return cache;
  try {
    const raw = localStore().getItem(assignmentKey());
    if (raw === null || raw === "") return cacheAll({});
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return cacheAll({});
    const out: Record<string, string> = {};
    for (const [itemId, budgetId] of Object.entries(parsed)) {
      if (isString(budgetId) && budgetId !== "") out[itemId] = budgetId;
    }
    return cacheAll(out);
  } catch {
    return cacheAll({});
  }
}

function persistCache(): void {
  if (cache === null) return;
  try {
    localStore().setItem(assignmentKey(), JSON.stringify(cache));
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
  cacheAll(next);
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
  cacheAll(next);
  persistCache();
}

export function unbindBudget(budgetId: string): void {
  setBudgetInstruments(budgetId, []);
}

export function clearInstrumentBudgets(): void {
  cacheAll({});
  try {
    localStore().removeItem(assignmentKey());
  } catch {
    // ignore
  }
}

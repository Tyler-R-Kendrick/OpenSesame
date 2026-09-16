/**
 * Ancestor-path holds for shared-counter and exclusive-allocation reserves.
 */

import { fail } from "./errors.js";
import type { NodeState } from "./state.js";
import type { BudgetTx } from "./store.js";
import type { AmountUnits, BudgetNodeRef, HoldSlice } from "./types.js";

export type { HoldSlice };

export function ancestorPath(
  tx: BudgetTx,
  leafId: BudgetNodeRef,
): BudgetNodeRef[] {
  const path: BudgetNodeRef[] = [];
  let current: BudgetNodeRef | null = leafId;
  const seen = new Set<BudgetNodeRef>();
  while (current !== null) {
    if (seen.has(current)) {
      fail("cycle_forbidden");
    }
    seen.add(current);
    path.push(current);
    const node = tx.getNode(current);
    if (node === undefined) {
      fail("node_not_found");
    }
    current = node.parentId;
  }
  return path;
}

function requireNode(tx: BudgetTx, id: BudgetNodeRef): NodeState {
  const node = tx.getNode(id);
  if (node === undefined) {
    fail("node_not_found");
  }
  return node;
}

/**
 * Deduct `amount` for a reservation along leaf→root.
 * Returns the ancestor slices that funded a shared-counter draw (empty for
 * exclusive / root-local spends).
 */
export function applyReserveHold(
  tx: BudgetTx,
  path: readonly BudgetNodeRef[],
  amount: AmountUnits,
): readonly HoldSlice[] {
  const leafId = path[0];
  if (leafId === undefined) {
    fail("node_not_found");
  }
  const leaf = requireNode(tx, leafId);

  if (leaf.parentId === null) {
    if (leaf.locallyAvailable < amount) {
      fail("insufficient_available");
    }
    leaf.locallyAvailable -= amount;
    leaf.unresolvedExternalExposure += amount;
    tx.putNode(leaf);
    return [];
  }

  const parent = requireNode(tx, leaf.parentId);

  if (parent.strategy === "exclusive_allocation") {
    if (leaf.locallyAvailable < amount) {
      fail("insufficient_available");
    }
    leaf.locallyAvailable -= amount;
    leaf.unresolvedExternalExposure += amount;
    tx.putNode(leaf);
    return [];
  }

  // shared_counter: pull from ancestors (nearest first), record each slice.
  let remaining = amount;
  const slices: HoldSlice[] = [];
  for (let i = 1; i < path.length; i += 1) {
    const ancestorId = path[i];
    if (ancestorId === undefined) {
      break;
    }
    const ancestor = requireNode(tx, ancestorId);
    if (ancestor.strategy === "exclusive_allocation") {
      // Cannot invent shared remainder across an exclusive boundary.
      continue;
    }
    const take =
      ancestor.locallyAvailable < remaining
        ? ancestor.locallyAvailable
        : remaining;
    if (take === 0n) {
      continue;
    }
    ancestor.locallyAvailable -= take;
    ancestor.reservedToChildren += take;
    tx.putNode(ancestor);
    slices.push({ nodeId: ancestorId, amount: take });
    remaining -= take;
    if (remaining === 0n) {
      break;
    }
  }

  if (remaining !== 0n) {
    fail("insufficient_available");
  }

  leaf.ceiling += amount;
  leaf.unresolvedExternalExposure += amount;
  tx.putNode(leaf);
  return slices;
}

export function reverseReserveHold(
  tx: BudgetTx,
  path: readonly BudgetNodeRef[],
  amount: AmountUnits,
  holds: readonly HoldSlice[],
  toPosted: boolean,
): void {
  const leafId = path[0];
  if (leafId === undefined) {
    fail("node_not_found");
  }
  const leaf = requireNode(tx, leafId);
  if (leaf.unresolvedExternalExposure < amount) {
    fail("attempt_not_reserved");
  }

  leaf.unresolvedExternalExposure -= amount;

  if (toPosted) {
    leaf.postedSpending += amount;
    tx.putNode(leaf);
    return;
  }

  if (leaf.parentId === null || holds.length === 0) {
    leaf.locallyAvailable += amount;
    tx.putNode(leaf);
    return;
  }

  // shared_counter release: shrink leaf ceiling and return each slice.
  if (leaf.ceiling < amount) {
    fail("attempt_not_reserved");
  }
  leaf.ceiling -= amount;
  tx.putNode(leaf);

  for (const slice of holds) {
    const ancestor = requireNode(tx, slice.nodeId);
    if (ancestor.reservedToChildren < slice.amount) {
      fail("attempt_not_reserved");
    }
    ancestor.reservedToChildren -= slice.amount;
    ancestor.locallyAvailable += slice.amount;
    tx.putNode(ancestor);
  }
}

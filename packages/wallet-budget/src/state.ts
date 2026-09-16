/**
 * Mutable node state held inside a transaction. Buckets are kept disjoint so
 * the conservation identity is a local check, not a global reconciliation.
 */

import type { JournalEntry } from "./journal.js";
import type {
  AllocationStrategy,
  AmountUnits,
  BudgetNodeRef,
  BudgetProjection,
  HoldSlice,
  PaymentAttemptId,
  ReservationRecord,
  ReservationState,
} from "./types.js";
import { conserves } from "./types.js";

export type NodeState = {
  readonly id: BudgetNodeRef;
  parentId: BudgetNodeRef | null;
  strategy: AllocationStrategy;
  ceiling: AmountUnits;
  postedSpending: AmountUnits;
  unresolvedExternalExposure: AmountUnits;
  reservedToChildren: AmountUnits;
  locallyAvailable: AmountUnits;
};

export type AttemptState = {
  attemptId: PaymentAttemptId;
  nodeId: BudgetNodeRef;
  amount: AmountUnits;
  state: ReservationState;
  path: readonly BudgetNodeRef[];
  holds: readonly HoldSlice[];
};

export type BudgetSnapshot = {
  readonly nodes: ReadonlyMap<BudgetNodeRef, NodeState>;
  readonly attempts: ReadonlyMap<PaymentAttemptId, AttemptState>;
  readonly journal: readonly JournalEntry[];
};

export function cloneNode(node: NodeState): NodeState {
  return {
    id: node.id,
    parentId: node.parentId,
    strategy: node.strategy,
    ceiling: node.ceiling,
    postedSpending: node.postedSpending,
    unresolvedExternalExposure: node.unresolvedExternalExposure,
    reservedToChildren: node.reservedToChildren,
    locallyAvailable: node.locallyAvailable,
  };
}

export function cloneAttempt(attempt: AttemptState): AttemptState {
  return {
    attemptId: attempt.attemptId,
    nodeId: attempt.nodeId,
    amount: attempt.amount,
    state: attempt.state,
    path: [...attempt.path],
    holds: attempt.holds.map((h) => ({ nodeId: h.nodeId, amount: h.amount })),
  };
}

export function projectNode(node: NodeState): BudgetProjection {
  const projection: BudgetProjection = {
    nodeId: node.id,
    ceiling: node.ceiling,
    strategy: node.strategy,
    parentId: node.parentId,
    postedSpending: node.postedSpending,
    unresolvedExternalExposure: node.unresolvedExternalExposure,
    reservedToChildren: node.reservedToChildren,
    locallyAvailable: node.locallyAvailable,
  };
  if (!conserves(projection)) {
    throw new Error(`Budget projection for ${node.id} broke conservation`);
  }
  return projection;
}

export function projectAttempt(attempt: AttemptState): ReservationRecord {
  return {
    attemptId: attempt.attemptId,
    nodeId: attempt.nodeId,
    amount: attempt.amount,
    state: attempt.state,
    path: attempt.path,
    holds: attempt.holds,
  };
}

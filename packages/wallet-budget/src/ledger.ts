/**
 * Atomic reserve / commit / release over an ancestor chain.
 *
 * Shared-counter parents expose one remainder; exclusive-allocation parents
 * require an explicit carve-out before a child can spend.
 */

import { BudgetError, budgetErrorMessage, fail } from "./errors.js";
import { ancestorPath, applyReserveHold, reverseReserveHold } from "./holds.js";
import {
  type SetCeilingInput,
  closeNodeInTx,
  setCeilingInTx,
} from "./node-lifecycle.js";
import type { AttemptState, BudgetSnapshot, NodeState } from "./state.js";
import { projectAttempt, projectNode } from "./state.js";
import type { BudgetStore, BudgetTx } from "./store.js";
import {
  type AllocationStrategy,
  type AmountUnits,
  type BudgetNodeRef,
  type BudgetProjection,
  type HoldSlice,
  type PaymentAttemptId,
  type ReservationRecord,
  assertAmountUnits,
} from "./types.js";

export type OpenNodeInput = {
  readonly nodeId: BudgetNodeRef;
  readonly parentId?: BudgetNodeRef | null;
  readonly ceiling: AmountUnits;
  readonly strategy: AllocationStrategy;
};

export type AllocateExclusiveInput = {
  readonly parentId: BudgetNodeRef;
  readonly childId: BudgetNodeRef;
  readonly amount: AmountUnits;
};

export type AllocateExclusiveResult = {
  readonly parent: BudgetProjection;
  readonly child: BudgetProjection;
};

export type ReserveInput = {
  readonly attemptId: PaymentAttemptId;
  readonly nodeId: BudgetNodeRef;
  readonly amount: AmountUnits;
};

export type { SetCeilingInput };

function requireId(value: string, label: string): string {
  if (value.length === 0) {
    throw new BudgetError(
      "invalid_amount",
      `${label} must be a non-empty reference`,
    );
  }
  return value;
}

function openNodeInTx(tx: BudgetTx, input: OpenNodeInput): BudgetProjection {
  const nodeId = requireId(input.nodeId, "nodeId");
  const ceiling = assertAmountUnits(input.ceiling, "ceiling");
  if (tx.getNode(nodeId) !== undefined) {
    fail("node_exists");
  }

  const parentId =
    input.parentId === undefined || input.parentId === null
      ? null
      : requireId(input.parentId, "parentId");

  if (parentId === nodeId) {
    fail("cycle_forbidden");
  }

  if (parentId !== null) {
    const parent = tx.getNode(parentId);
    if (parent === undefined) {
      fail("orphan_parent");
    }
    // Children never invent authority; they open at zero and draw via strategy.
    if (ceiling !== 0n) {
      throw new BudgetError(
        "wrong_strategy",
        "Child nodes open with a zero ceiling; authority moves via allocate or shared reserve.",
      );
    }
  }

  const node: NodeState = {
    id: nodeId,
    parentId,
    strategy: input.strategy,
    ceiling,
    postedSpending: 0n,
    unresolvedExternalExposure: 0n,
    reservedToChildren: 0n,
    locallyAvailable: ceiling,
  };

  tx.putNode(node);
  tx.append({
    kind: "node_opened",
    nodeId,
    parentId,
    ceiling,
    strategy: input.strategy,
  });
  return projectNode(node);
}

function allocateExclusiveInTx(
  tx: BudgetTx,
  input: AllocateExclusiveInput,
): AllocateExclusiveResult {
  const amount = assertAmountUnits(input.amount, "amount");
  if (amount === 0n) {
    fail("invalid_amount");
  }
  const parent = tx.getNode(requireId(input.parentId, "parentId"));
  const child = tx.getNode(requireId(input.childId, "childId"));
  if (parent === undefined || child === undefined) {
    fail("node_not_found");
  }
  if (child.parentId !== parent.id) {
    fail("parent_required");
  }
  if (parent.strategy !== "exclusive_allocation") {
    fail("wrong_strategy");
  }
  if (parent.locallyAvailable < amount) {
    fail("insufficient_available");
  }

  parent.locallyAvailable -= amount;
  parent.reservedToChildren += amount;
  child.ceiling += amount;
  child.locallyAvailable += amount;

  tx.putNode(parent);
  tx.putNode(child);
  tx.append({
    kind: "exclusive_allocated",
    parentId: parent.id,
    childId: child.id,
    amount,
  });
  return { parent: projectNode(parent), child: projectNode(child) };
}

function sameReservation(
  existing: AttemptState,
  nodeId: BudgetNodeRef,
  amount: AmountUnits,
  path: readonly BudgetNodeRef[],
  holds: readonly HoldSlice[],
): boolean {
  if (existing.nodeId !== nodeId) return false;
  if (existing.amount !== amount) return false;
  if (existing.path.length !== path.length) return false;
  for (let i = 0; i < path.length; i += 1) {
    if (existing.path[i] !== path[i]) return false;
  }
  if (existing.holds.length !== holds.length) return false;
  for (let i = 0; i < holds.length; i += 1) {
    const a = existing.holds[i];
    const b = holds[i];
    if (a === undefined || b === undefined) return false;
    if (a.nodeId !== b.nodeId || a.amount !== b.amount) return false;
  }
  return true;
}

function reserveInTx(tx: BudgetTx, input: ReserveInput): ReservationRecord {
  const attemptId = requireId(input.attemptId, "attemptId");
  const nodeId = requireId(input.nodeId, "nodeId");
  const amount = assertAmountUnits(input.amount, "amount");
  if (amount === 0n) {
    fail("invalid_amount");
  }

  const existing = tx.getAttempt(attemptId);
  const path = ancestorPath(tx, nodeId);

  if (existing !== undefined) {
    if (existing.state !== "reserved") {
      fail("attempt_conflict");
    }
    // Idempotent replay must match the original bind; we re-check path only.
    if (!sameReservation(existing, nodeId, amount, path, existing.holds)) {
      fail("attempt_conflict");
    }
    return projectAttempt(existing);
  }

  const holds = applyReserveHold(tx, path, amount);
  const attempt: AttemptState = {
    attemptId,
    nodeId,
    amount,
    state: "reserved",
    path,
    holds,
  };
  tx.putAttempt(attempt);
  tx.append({
    kind: "reserved",
    attemptId,
    nodeId,
    amount,
    path,
    holds,
  });
  return projectAttempt(attempt);
}

function commitInTx(
  tx: BudgetTx,
  attemptId: PaymentAttemptId,
): ReservationRecord {
  const id = requireId(attemptId, "attemptId");
  const existing = tx.getAttempt(id);
  if (existing === undefined) {
    fail("attempt_not_reserved");
  }
  if (existing.state === "committed") {
    return projectAttempt(existing);
  }
  if (existing.state !== "reserved") {
    fail("attempt_not_reserved");
  }
  reverseReserveHold(tx, existing.path, existing.amount, existing.holds, true);
  existing.state = "committed";
  tx.putAttempt(existing);
  tx.append({ kind: "committed", attemptId: id });
  return projectAttempt(existing);
}

function releaseInTx(
  tx: BudgetTx,
  attemptId: PaymentAttemptId,
): ReservationRecord {
  const id = requireId(attemptId, "attemptId");
  const existing = tx.getAttempt(id);
  if (existing === undefined) {
    fail("attempt_not_reserved");
  }
  if (existing.state === "released") {
    return projectAttempt(existing);
  }
  if (existing.state !== "reserved") {
    fail("attempt_not_reserved");
  }
  reverseReserveHold(tx, existing.path, existing.amount, existing.holds, false);
  existing.state = "released";
  tx.putAttempt(existing);
  tx.append({ kind: "released", attemptId: id });
  return projectAttempt(existing);
}

export type BudgetLedger = {
  openNode(input: OpenNodeInput): BudgetProjection;
  setCeiling(input: SetCeilingInput): BudgetProjection;
  closeNode(nodeId: BudgetNodeRef): BudgetProjection;
  allocateExclusive(input: AllocateExclusiveInput): AllocateExclusiveResult;
  reserve(input: ReserveInput): ReservationRecord;
  commit(attemptId: PaymentAttemptId): ReservationRecord;
  release(attemptId: PaymentAttemptId): ReservationRecord;
  project(nodeId: BudgetNodeRef): BudgetProjection | undefined;
  projectAttempt(attemptId: PaymentAttemptId): ReservationRecord | undefined;
  /** All node projections (conserved). */
  listNodes(): readonly BudgetProjection[];
  snapshot(): BudgetSnapshot;
  /** Run several mutations in one atomic transaction. */
  transact<T>(body: (ledger: BudgetLedgerTx) => T): T;
};

export type BudgetLedgerTx = {
  openNode(input: OpenNodeInput): BudgetProjection;
  setCeiling(input: SetCeilingInput): BudgetProjection;
  closeNode(nodeId: BudgetNodeRef): BudgetProjection;
  allocateExclusive(input: AllocateExclusiveInput): AllocateExclusiveResult;
  reserve(input: ReserveInput): ReservationRecord;
  commit(attemptId: PaymentAttemptId): ReservationRecord;
  release(attemptId: PaymentAttemptId): ReservationRecord;
  project(nodeId: BudgetNodeRef): BudgetProjection | undefined;
  projectAttempt(attemptId: PaymentAttemptId): ReservationRecord | undefined;
};

function bindTx(tx: BudgetTx): BudgetLedgerTx {
  return {
    openNode: (input) => openNodeInTx(tx, input),
    setCeiling: (input) => setCeilingInTx(tx, input),
    closeNode: (nodeId) => closeNodeInTx(tx, nodeId),
    allocateExclusive: (input) => allocateExclusiveInTx(tx, input),
    reserve: (input) => reserveInTx(tx, input),
    commit: (attemptId) => commitInTx(tx, attemptId),
    release: (attemptId) => releaseInTx(tx, attemptId),
    project: (nodeId) => {
      const node = tx.getNode(nodeId);
      return node === undefined ? undefined : projectNode(node);
    },
    projectAttempt: (attemptId) => {
      const attempt = tx.getAttempt(attemptId);
      return attempt === undefined ? undefined : projectAttempt(attempt);
    },
  };
}

export function createBudgetLedger(store: BudgetStore): BudgetLedger {
  return {
    openNode: (input) => store.transact((tx) => openNodeInTx(tx, input)),
    setCeiling: (input) => store.transact((tx) => setCeilingInTx(tx, input)),
    closeNode: (nodeId) => store.transact((tx) => closeNodeInTx(tx, nodeId)),
    allocateExclusive: (input) =>
      store.transact((tx) => allocateExclusiveInTx(tx, input)),
    reserve: (input) => store.transact((tx) => reserveInTx(tx, input)),
    commit: (attemptId) => store.transact((tx) => commitInTx(tx, attemptId)),
    release: (attemptId) => store.transact((tx) => releaseInTx(tx, attemptId)),
    listNodes: () =>
      store.transact((tx) => tx.listNodes().map((node) => projectNode(node))),
    snapshot: () => store.snapshot(),
    project: (nodeId) =>
      store.transact((tx) => {
        const node = tx.getNode(nodeId);
        return node === undefined ? undefined : projectNode(node);
      }),
    projectAttempt: (attemptId) =>
      store.transact((tx) => {
        const attempt = tx.getAttempt(attemptId);
        return attempt === undefined ? undefined : projectAttempt(attempt);
      }),
    transact: (body) => store.transact((tx) => body(bindTx(tx))),
  };
}

export { BudgetError, budgetErrorMessage };

/**
 * Minimal wallet-budget domain types.
 *
 * DOM (`packages/os-domain/src/wallet/`) is not merged yet, so AmountUnits and
 * refs live here. When DOM lands, these can re-export or narrow against it.
 */

/** Smallest currency subunit as a non-negative integer. Never float. */
export type AmountUnits = bigint;

/** Stable id for a budget node in the authority tree. */
export type BudgetNodeRef = string;

/** Logical payment attempt — the idempotency key for reserve/commit/release. */
export type PaymentAttemptId = string;

/**
 * How a parent redistributes authority to children.
 *
 * - `shared_counter` — children compete for the parent's locally-available
 *   remainder; reservations walk ancestors and deduct from the shared pool.
 * - `exclusive_allocation` — a parent must first carve exclusive slices to
 *   children; a child then spends only from its own ceiling.
 */
export type AllocationStrategy = "shared_counter" | "exclusive_allocation";

/**
 * Four DISJOINT projection categories for one node.
 *
 * Conservation identity (always):
 *   postedSpending + unresolvedExternalExposure
 *     + reservedToChildren + locallyAvailable === ceiling
 */
export type BudgetProjection = {
  readonly nodeId: BudgetNodeRef;
  readonly ceiling: AmountUnits;
  readonly strategy: AllocationStrategy;
  readonly parentId: BudgetNodeRef | null;
  readonly postedSpending: AmountUnits;
  readonly unresolvedExternalExposure: AmountUnits;
  readonly reservedToChildren: AmountUnits;
  readonly locallyAvailable: AmountUnits;
};

export type ReservationState = "reserved" | "committed" | "released";

/** One ancestor contribution that funded a shared-counter reservation. */
export type HoldSlice = {
  readonly nodeId: BudgetNodeRef;
  readonly amount: AmountUnits;
};

export type ReservationRecord = {
  readonly attemptId: PaymentAttemptId;
  readonly nodeId: BudgetNodeRef;
  readonly amount: AmountUnits;
  readonly state: ReservationState;
  /** Ancestor chain touched at reserve time (leaf → root). */
  readonly path: readonly BudgetNodeRef[];
  /** Shared-counter funding slices; empty for exclusive / root-local holds. */
  readonly holds: readonly HoldSlice[];
};

export function isAmountUnits(value: bigint): boolean {
  return value >= 0n;
}

export function assertAmountUnits(value: bigint, label: string): AmountUnits {
  if (!isAmountUnits(value)) {
    throw new RangeError(`${label} must be a non-negative AmountUnits`);
  }
  return value;
}

/** Sum the four disjoint buckets; used by conservation checks. */
export function projectionTotal(p: BudgetProjection): AmountUnits {
  return (
    p.postedSpending +
    p.unresolvedExternalExposure +
    p.reservedToChildren +
    p.locallyAvailable
  );
}

export function conserves(p: BudgetProjection): boolean {
  return projectionTotal(p) === p.ceiling;
}

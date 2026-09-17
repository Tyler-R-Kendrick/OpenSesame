/**
 * Append-only journal entries. The in-memory store projects node + attempt
 * state from this log; persistence adapters can replay the same shapes later.
 */

import type {
  AllocationStrategy,
  AmountUnits,
  BudgetNodeRef,
  HoldSlice,
  PaymentAttemptId,
} from "./types.js";

export type JournalEntry =
  | {
      readonly kind: "node_opened";
      readonly nodeId: BudgetNodeRef;
      readonly parentId: BudgetNodeRef | null;
      readonly ceiling: AmountUnits;
      readonly strategy: AllocationStrategy;
    }
  | {
      readonly kind: "exclusive_allocated";
      readonly parentId: BudgetNodeRef;
      readonly childId: BudgetNodeRef;
      readonly amount: AmountUnits;
    }
  | {
      readonly kind: "reserved";
      readonly attemptId: PaymentAttemptId;
      readonly nodeId: BudgetNodeRef;
      readonly amount: AmountUnits;
      readonly path: readonly BudgetNodeRef[];
      readonly holds: readonly HoldSlice[];
    }
  | {
      readonly kind: "committed";
      readonly attemptId: PaymentAttemptId;
    }
  | {
      readonly kind: "released";
      readonly attemptId: PaymentAttemptId;
    }
  | {
      readonly kind: "ceiling_set";
      readonly nodeId: BudgetNodeRef;
      readonly ceiling: AmountUnits;
    }
  | {
      readonly kind: "node_closed";
      readonly nodeId: BudgetNodeRef;
    };

export type BudgetJournal = {
  readonly entries: readonly JournalEntry[];
};

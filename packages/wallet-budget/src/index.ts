/**
 * `@opensesame/wallet-budget` — pure budget journal for wallet spending
 * authority (Swarm LEDGER). No React, no network, no EVM.
 */

export {
  BUDGET_ERROR_CODES,
  BudgetError,
  budgetErrorMessage,
  type BudgetErrorCode,
} from "./errors.js";
export {
  createBudgetLedger,
  type AllocateExclusiveInput,
  type AllocateExclusiveResult,
  type BudgetLedger,
  type BudgetLedgerTx,
  type OpenNodeInput,
  type ReserveInput,
} from "./ledger.js";
export type { BudgetJournal, JournalEntry } from "./journal.js";
export {
  createInMemoryBudgetStore,
  InMemoryBudgetStore,
  type BudgetStore,
  type BudgetTx,
} from "./store.js";
export type { AttemptState, BudgetSnapshot, NodeState } from "./state.js";
export {
  assertAmountUnits,
  conserves,
  isAmountUnits,
  projectionTotal,
  type AllocationStrategy,
  type AmountUnits,
  type BudgetNodeRef,
  type BudgetProjection,
  type HoldSlice,
  type PaymentAttemptId,
  type ReservationRecord,
  type ReservationState,
} from "./types.js";

/**
 * Typed failures for the budget journal. Messages are fixed sentences so
 * callers can branch on `code` without scraping prose.
 */

export const BUDGET_ERROR_CODES = [
  "node_not_found",
  "node_exists",
  "invalid_amount",
  "insufficient_available",
  "parent_required",
  "wrong_strategy",
  "attempt_conflict",
  "attempt_not_reserved",
  "cycle_forbidden",
  "orphan_parent",
] as const;

export type BudgetErrorCode = (typeof BUDGET_ERROR_CODES)[number];

export class BudgetError extends Error {
  readonly code: BudgetErrorCode;

  constructor(code: BudgetErrorCode, message: string) {
    super(message);
    this.name = "BudgetError";
    this.code = code;
  }
}

export function budgetErrorMessage(code: BudgetErrorCode): string {
  switch (code) {
    case "node_not_found":
      return "No budget node exists for that reference.";
    case "node_exists":
      return "A budget node with that reference is already open.";
    case "invalid_amount":
      return "AmountUnits must be a non-negative integer.";
    case "insufficient_available":
      return "The remaining locally available authority is not enough.";
    case "parent_required":
      return "This operation requires a parent budget node.";
    case "wrong_strategy":
      return "The parent allocation strategy does not allow this operation.";
    case "attempt_conflict":
      return "That payment attempt id already binds a different reservation.";
    case "attempt_not_reserved":
      return "That payment attempt is not in the reserved state.";
    case "cycle_forbidden":
      return "A budget node cannot be its own ancestor.";
    case "orphan_parent":
      return "The named parent budget node does not exist.";
  }
}

export function fail(code: BudgetErrorCode): never {
  throw new BudgetError(code, budgetErrorMessage(code));
}

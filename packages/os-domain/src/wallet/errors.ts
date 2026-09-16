import type { JsonObject } from "../json.js";

/**
 * Typed Wallet spending error codes (directive vocabulary + core amount/intent).
 *
 * Public messages name the actionable condition only — never credentials,
 * signatures, or cross-domain account existence.
 */
export type WalletErrorCode =
  | "WALLET_LOCKED"
  | "AUTHORITY_NOT_CONFIGURED"
  | "CALLER_NOT_AUTHORIZED"
  | "DOMAIN_MISMATCH"
  | "PROOF_BINDING_INVALID"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_DIGEST_MISMATCH"
  | "POLICY_VERSION_CONFLICT"
  | "POLICY_WIDENING_REFUSED"
  | "REQUIRED_CONSTRAINT_UNSUPPORTED"
  | "PERIOD_SEMANTICS_UNSUPPORTED"
  | "INDEPENDENT_ENFORCEMENT_UNAVAILABLE"
  | "ACCOUNTING_AUTHORITY_UNAVAILABLE"
  | "BUDGET_OPERATION_NOT_AUTHORIZED"
  | "AMOUNT_INVALID"
  | "AMOUNT_OVERFLOW"
  | "AMOUNT_PRECISION_EXCEEDED"
  | "INSUFFICIENT_CAPACITY"
  | "DESTINATION_IDENTITY_REQUIRED"
  | "INTENT_INVALID"
  | "IDEMPOTENCY_SCOPE_REQUIRED"
  | "LIFECYCLE_TRANSITION_INVALID"
  | "CRITICAL_EXTENSION_UNSUPPORTED";

/** Whether a caller may safely retry the same logical operation. */
export type WalletRetryability = "never" | "same_idempotency" | "after_fix";

export type WalletErrorOptions = {
  readonly retryability?: WalletRetryability;
  readonly details?: JsonObject;
};

const EMPTY_WALLET_ERROR_OPTIONS: WalletErrorOptions = {};

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly retryability: WalletRetryability;
  readonly details: JsonObject;

  constructor(
    code: WalletErrorCode,
    message: string,
    options: WalletErrorOptions = EMPTY_WALLET_ERROR_OPTIONS,
  ) {
    super(message);
    this.name = "WalletError";
    this.code = code;
    this.retryability = options.retryability ?? "never";
    this.details = options.details ?? {};
  }
}

export function walletError(
  code: WalletErrorCode,
  message: string,
  options: WalletErrorOptions = EMPTY_WALLET_ERROR_OPTIONS,
): WalletError {
  return new WalletError(code, message, options);
}

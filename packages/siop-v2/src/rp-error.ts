/**
 * Every refusal of a relying-party login that is about the login rather than
 * the token (ADR 0161). Token refusals stay `SiopV2Error` (`nonce_mismatch`,
 * `audience_mismatch`, `token_expired`, `signature_invalid`, ...):
 * `error.code` is a stable machine-readable string either way, and neither
 * message carries token contents.
 */

export type SiopRpErrorCode =
  | "invalid_configuration"
  | "missing_state"
  | "login_unknown"
  | "login_replayed"
  | "login_expired"
  | "redirect_mismatch"
  | "token_replayed"
  | "provider_error"
  | "capacity_exceeded";

const RP_MESSAGES = {
  invalid_configuration: "relying party configuration is not acceptable",
  missing_state: "the response carries no state",
  login_unknown: "no login is waiting for this response",
  login_replayed: "this login was already completed",
  login_expired: "this login expired before the response arrived",
  redirect_mismatch: "the response arrived at a different redirect_uri",
  token_replayed: "this ID Token was already accepted",
  provider_error: "the Self-Issued OP returned an error",
  capacity_exceeded: "too many logins are waiting; try again shortly",
} as const satisfies Record<SiopRpErrorCode, string>;

export class SiopRpError extends Error {
  readonly code: SiopRpErrorCode;
  /** The OP's own `error` value (`access_denied`), when it sent one. */
  readonly providerError: string | null;

  constructor(code: SiopRpErrorCode, providerError: string | null = null) {
    super(RP_MESSAGES[code]);
    this.name = "SiopRpError";
    this.code = code;
    this.providerError = providerError;
  }
}

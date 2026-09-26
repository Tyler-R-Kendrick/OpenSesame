/**
 * How an Identity-account factor ceremony (`./account-factors.ts`) ends
 * short, as the person is told it, and how the service's refusals map onto
 * those sentences. One sentence per refusal; a transport failure, a refused
 * code and an unreadable answer are told apart only where the person can
 * act on it.
 *
 * A refused step-up (ADR 0146) is a 403 with its own code and its own
 * sentence — never "signed_out": only a 401 means the session ended.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

/** Every way a factor ceremony can end short, as the person is told it. */
export const ACCOUNT_FACTOR_WORDS = {
  signed_out: "Your session ended. Sign in again, then try once more.",
  unreachable: "Your sign-in service did not answer. Nothing changed.",
  invalid_response:
    "Your sign-in service answered with something this app cannot read. Nothing changed.",
  unavailable: "This browser cannot make a passkey.",
  cancelled: "No passkey was made. Nothing changed.",
  invalid_credential:
    "The passkey the browser made could not be read. Nothing was saved.",
  not_accepted:
    "Your sign-in service did not accept that passkey. Nothing was saved.",
  totp_unavailable: "Your sign-in service does not offer authenticator codes.",
  not_enrolled: "No authenticator setup is waiting. Start again.",
  wrong_code:
    "That code did not match. Wait for the next one, then enter it before it changes.",
  too_many_attempts:
    "Too many codes tried. Wait a few minutes, then start again.",
  rate_limited: "Too many tries. Wait a minute, then try again.",
  not_found: "That factor is already gone.",
  step_up_required:
    "Your sign-in service asks you to prove it is you first. Nothing was removed.",
  step_up_failed:
    "Your sign-in service did not accept that proof. Nothing was removed.",
  step_up_cancelled: "No passkey was used. Nothing was removed.",
  failed: "That did not work. Nothing changed.",
} as const;

export type AccountFactorRefusal = keyof typeof ACCOUNT_FACTOR_WORDS;

export class AccountFactorError extends Error {
  readonly code: AccountFactorRefusal;
  constructor(code: AccountFactorRefusal) {
    super(ACCOUNT_FACTOR_WORDS[code]);
    this.name = "AccountFactorError";
    this.code = code;
  }
}

/** The service's error codes, by what the person is told. */
const SERVICE_ERRORS: Readonly<Record<string, AccountFactorRefusal>> = {
  unauthorized: "signed_out",
  registration_verification_failed: "not_accepted",
  registration_attestation_required: "not_accepted",
  invalid_request: "not_accepted",
  totp_dev_only: "totp_unavailable",
  not_enrolled: "not_enrolled",
  too_many_attempts: "too_many_attempts",
  rate_limited: "rate_limited",
  not_found: "not_found",
  step_up_required: "step_up_required",
  step_up_failed: "step_up_failed",
};

/** A non-2xx answer, as the one sentence the person is told. */
export function refusalOf(
  status: number,
  body: BoundaryValue,
): AccountFactorError {
  const code =
    isJsonObject(body) && isString(body.error) ? body.error : undefined;
  if (code !== undefined && SERVICE_ERRORS[code]) {
    return new AccountFactorError(SERVICE_ERRORS[code]);
  }
  if (status === 401) return new AccountFactorError("signed_out");
  if (status === 429) return new AccountFactorError("rate_limited");
  return new AccountFactorError("failed");
}

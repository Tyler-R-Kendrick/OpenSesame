import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import { CeremonyRequestError } from "./device.js";

/**
 * How an interaction call fails (ADR 0086). Split out of
 * `interaction-client.ts` so the approval model (`interaction-approval.ts`)
 * can word a refusal without reaching into the transport.
 *
 * Server prose never becomes an error message: a failure maps to a closed code
 * union with messages this package owns. The body's own code is kept only as
 * a key (`declared`) to look one of our sentences up by — never as text.
 */

/**
 * Every way answering an interaction can fail, as a stable string.
 *
 * A closed union rather than a status code because surfaces branch on meaning:
 * "expired" offers a fresh link, "approval_required" starts sign-in,
 * "digest_mismatch" must scare the user, and `rate_limited` should not.
 * `interaction_unavailable` is the deliberate catch-all — a 500, a proxy error
 * page, an unreachable host and an unparseable body are the same fact to the
 * person holding the phone, and inventing distinctions the client cannot
 * actually verify would only invite callers to trust them.
 */
export type InteractionErrorCode =
  | "interaction_not_found"
  | "interaction_expired"
  | "interaction_revoked"
  | "interaction_consumed"
  | "approval_required"
  | "digest_mismatch"
  | "approval_denied"
  | "rate_limited"
  | "interaction_unavailable";

/**
 * The message shown for each code.
 *
 * Ours, constant, and terse in ADR 0061's voice: what happened, and at most
 * what to do about it. No explanation of the protocol, and — critically — no
 * substitution of anything that arrived over the wire.
 */
export const INTERACTION_ERROR_WORDS = {
  interaction_not_found: "That request could not be found.",
  interaction_expired: "That request has expired.",
  interaction_revoked: "That request was withdrawn.",
  interaction_consumed: "That request was already used.",
  approval_required: "Sign in to answer this request.",
  digest_mismatch:
    "This request changed since it was shown. Nothing was approved.",
  approval_denied: "That request was already denied.",
  rate_limited: "Too many attempts. Try again shortly.",
  interaction_unavailable:
    "That request could not be answered. Try again shortly.",
} as const satisfies Record<InteractionErrorCode, string>;

const CODES: ReadonlySet<string> = new Set(
  Object.keys(INTERACTION_ERROR_WORDS),
);

/** A body code worth keeping as a key: an identifier, and a short one. */
const DECLARED = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A failed interaction call.
 *
 * Extends `CeremonyRequestError` rather than starting a parallel hierarchy:
 * every ceremony surface already catches that type and reads `.status`, so an
 * interaction failure stays catchable by code written before interactions
 * existed, and `.code` is the added precision.
 */
export class InteractionError extends CeremonyRequestError {
  readonly code: InteractionErrorCode;
  /**
   * The code the response body named when it was identifier-shaped, else
   * `""`. The server names refusals the closed union has no room for
   * (`interaction_settled`, `proof_required`, the `activation_*` family), and
   * `interactionRefusal` words them by this key. Never shown as text.
   */
  readonly declared: string;
  constructor(status: number, code: InteractionErrorCode, declared = "") {
    super(status, INTERACTION_ERROR_WORDS[code]);
    this.name = "InteractionError";
    this.code = code;
    this.declared = declared;
  }
}

/**
 * HTTP status to code.
 *
 * `410 Gone` covers expiry, revocation and consumption alike — all three are
 * "this existed and is finished" — so it defaults to expiry and is refined by
 * the body. `409` is reserved for the digest check because a digest mismatch
 * is precisely a conflict between what the client was shown and what the
 * server holds. `403` is a decision already recorded against the caller,
 * whereas `401` is the absence of one.
 */
export function interactionCodeForStatus(status: number): InteractionErrorCode {
  switch (status) {
    case 401:
      return "approval_required";
    case 403:
      return "approval_denied";
    case 404:
      return "interaction_not_found";
    case 409:
      return "digest_mismatch";
    case 410:
      return "interaction_expired";
    case 429:
      return "rate_limited";
    default:
      return "interaction_unavailable";
  }
}

function isErrorCode(value: string): value is InteractionErrorCode {
  return CODES.has(value);
}

export async function readJsonBody(res: Response): Promise<JsonObject | null> {
  try {
    const parsed: BoundaryValue = await res.json();
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Turn a failed response into a typed error.
 *
 * The body may *select* one of our codes and may do nothing else: it is read
 * only through `isErrorCode`, so an unrecognised value falls back to the
 * status mapping and an attacker-controlled string can at worst pick a
 * different one of our sentences. Nothing from the response — not the body,
 * not a header, not the reason phrase — reaches the thrown message.
 */
export async function failure(res: Response): Promise<InteractionError> {
  const body = await readJsonBody(res);
  const named = body === null ? undefined : readString(body.error ?? body.code);
  const declared = named !== undefined && DECLARED.test(named) ? named : "";
  const code = isErrorCode(declared)
    ? declared
    : interactionCodeForStatus(res.status);
  return new InteractionError(res.status, code, declared);
}

export function malformed(): InteractionError {
  // A response we cannot read is indistinguishable, from here, from a captive
  // portal or a middlebox. It is never treated as an approval of anything.
  return new InteractionError(0, "interaction_unavailable");
}

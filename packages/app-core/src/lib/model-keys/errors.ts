/**
 * A refusal has two faces (ADR 0192 §4).
 *
 * The wire face is an RFC error code and a fixed sentence: a caller learns that
 * it was refused, never which of a dozen checks said so, because that is how a
 * probing client maps what a grant holds. The audit face is a stable `reason`
 * for the person who owns the key. Neither carries a token, a prompt or a
 * credential, so a refusal is safe to log, show and test.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import type { OAuthError } from "./vocabulary.js";

const DESCRIPTIONS = {
  invalid_request: "The request is malformed.",
  invalid_grant: "The subject token is not valid.",
  invalid_scope: "The requested scope is not permitted.",
  invalid_target: "The requested resource is not permitted.",
  invalid_authorization_details:
    "The requested authorization details are not permitted.",
  invalid_dpop_proof: "The proof of possession is not valid.",
  unsupported_grant_type: "This grant type is not supported.",
  invalid_token: "The key is not valid.",
  insufficient_scope: "The key does not permit this request.",
  access_denied: "The request was not approved.",
  temporarily_unavailable: "Try again.",
} as const satisfies Readonly<Record<OAuthError, string>>;

export class ModelKeyRefusal extends Error {
  readonly error: OAuthError;
  /** Stable, value-blind, for the key's owner: `escalation.models`, `parent.revoked`. */
  readonly reason: string;

  constructor(error: OAuthError, reason: string) {
    super(DESCRIPTIONS[error]);
    this.name = "ModelKeyRefusal";
    this.error = error;
    this.reason = reason;
  }

  /** The body a caller is shown (RFC 6749 §5.2), and nothing else. */
  toWire() {
    return { error: this.error, error_description: this.message };
  }
}

export function refuse(error: OAuthError, reason: string): never {
  throw new ModelKeyRefusal(error, reason);
}

export function isRefusal(value: BoundaryValue): value is ModelKeyRefusal {
  return value instanceof ModelKeyRefusal;
}

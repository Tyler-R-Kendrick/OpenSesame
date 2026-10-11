/**
 * The names a model key exchange speaks in (ADR 0190).
 *
 * An OpenSesame model key stands for a connection's credential without being
 * it. An app or agent asks for one by RFC 8693 token exchange, names the
 * resource it will use it on (RFC 8707), describes what it wants in an RFC 9396
 * authorization detail, and binds it to a key it holds (RFC 9449). Every name
 * and every bound below is written once, here, so a request, a ledger row and
 * a test cannot disagree about what a word means.
 */

/** RFC 8693 §2.1. */
export const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";

/** RFC 8693 §3: every key, root or derived, is an access token. */
export const ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

/** The marker a model key starts with: no provider's prefix, so a leak is recognizable (ADR 0150 §3). */
export const KEY_PREFIX = "osk_";
export const KEY_PATTERN = /^osk_[A-Za-z0-9_-]{43}$/;

/** RFC 9396: the detail type this exchange understands. */
export const DETAIL_TYPE = "model_access";

export const ACTIONS = ["model.invoke", "model.list"] as const;
export type ModelAction = (typeof ACTIONS)[number];
export function isModelAction(value: string): value is ModelAction {
  return ACTIONS.some((action) => action === value);
}

/** Consumable budget keys. `max_*` keys are caps on one request, never spent. */
export const CONSUMABLES = [
  "requests",
  "input_tokens",
  "output_tokens",
] as const;
export type Consumable = (typeof CONSUMABLES)[number];
export const CAP_OUTPUT_TOKENS = "max_output_tokens";
export const BUDGET_KEYS: readonly string[] = [
  ...CONSUMABLES,
  CAP_OUTPUT_TOKENS,
];

/** The exchange's hard ceilings; a broker's own policy may only lower them. */
export const LIMITS = {
  /** Request parameters and their size, before anything is parsed. */
  maxParams: 16,
  maxParamLength: 4096,
  maxProofLength: 4096,
  maxModelsPerKey: 32,
  maxModelLength: 160,
  /** A key is never longer lived than this, whatever the policy says. */
  maxLifetimeSeconds: 24 * 60 * 60,
  maxDelegationDepth: 3,
  maxKeys: 256,
  maxChildrenPerKey: 32,
  maxInFlightPerKey: 8,
  maxBodyBytes: 128 * 1024,
  maxBudget: 1_000_000_000,
} as const;

/** Resource-server and token-endpoint error names, RFC 6749 §5.2 and the RFCs beside it. */
export type OAuthError =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_scope"
  | "invalid_target"
  | "invalid_authorization_details"
  | "invalid_dpop_proof"
  | "unsupported_grant_type"
  | "invalid_token"
  | "insufficient_scope"
  | "access_denied"
  | "temporarily_unavailable";

/**
 * The only failure type this package throws.
 *
 * An issuer is a signing oracle sitting behind a parser, and the parser is
 * reachable by anyone who can reach the Credential Endpoint. That shapes two
 * rules, both enforced here rather than at each call site:
 *
 * **Messages are constants.** Never the rejected `aud`, never the algorithm
 * that was refused, never a prefix of the token, never the nonce. Anything
 * quoted back from input is an attacker-controlled write primitive into the
 * operator's log sink, and an issuer's logs are read by humans deciding
 * whether to trust a wallet. What varies between failures is the `code` — a
 * closed union callers may switch on — and nothing else.
 *
 * **No `cause` chaining.** `jose` throws `JWSSignatureVerificationFailed`,
 * `JSON.parse` throws a `SyntaxError` carrying the offending byte offset, and
 * a caller that logs `err` formats `err.cause` along with it. Attaching the
 * underlying error would restore exactly the leak this wrapper exists to
 * prevent, and would pin our error surface to a dependency's changelog.
 *
 * The `oauthError` mapping is separate from `code` on purpose. `code` is for
 * us — it says which check failed, at whatever granularity we found useful.
 * `oauthError` is what may cross the wire, and OpenID4VCI 1.0 §8.3.1.2 defines
 * a deliberately coarse vocabulary there: a wallet learns that its proof was
 * bad, not *which* of nine checks rejected it. Collapsing many codes onto one
 * wire error is the point, not an accident of the mapping.
 */

/**
 * Stable refusal codes.
 *
 * Codes are added, never renamed or repurposed: a caller that switches on
 * `"nonce_replayed"` to raise a different alert than `"nonce_unknown"` is
 * relying on the distinction, even though both leave here as `invalid_nonce`.
 */
export type Openid4vciErrorCode =
  /** Issuer configuration is incomplete, or names a URL this profile refuses. */
  | "invalid_issuer_configuration"
  /** An offer could not be built from the supplied parameters. */
  | "invalid_offer"
  /**
   * A link that would have carried a token, a code, or a credential in its
   * query or fragment. Thrown before the link is returned, never after.
   */
  | "offer_link_would_leak"
  /** The proof JWT is not a well-formed compact JWS with a signature. */
  | "malformed_proof"
  /** `typ` is absent or is not `openid4vci-proof+jwt`. */
  | "proof_typ_mismatch"
  /** `alg` is outside the allow-list — includes `none` and every `HS*`. */
  | "proof_algorithm_not_allowed"
  /** The JOSE header does not carry exactly one usable key reference. */
  | "proof_key_reference_invalid"
  /** `aud` is not this Credential Issuer's identifier. */
  | "proof_audience_mismatch"
  /** `iat` is missing, malformed, or outside the freshness window. */
  | "proof_not_fresh"
  /** `iss` is present, which this profile's anonymous grant forbids. */
  | "proof_issuer_claim_forbidden"
  /** The signature does not verify under the key the header embedded. */
  | "proof_signature_invalid"
  /** `nonce` is absent or not a string. */
  | "nonce_missing"
  /** The nonce was never issued here, or has already lapsed. */
  | "nonce_unknown"
  /** The nonce was issued here and has already been spent. */
  | "nonce_replayed"
  /** The pre-authorized code is unknown, expired, or already redeemed. */
  | "pre_authorized_code_rejected"
  /** A claim the credential must never carry was supplied to the minter. */
  | "forbidden_credential_claim"
  /** A subject or device reference that is not an opaque pairwise handle. */
  | "subject_reference_invalid"
  /** Credential minting was asked for something this profile cannot produce. */
  | "issuance_refused";

/**
 * The error codes OpenID4VCI 1.0 §8.3.1.2 permits at the Credential Endpoint,
 * plus the two token-endpoint codes the pre-authorized grant needs.
 *
 * `invalid_grant` and `invalid_request` are RFC 6749 §5.2; the rest are
 * OpenID4VCI's own. Nothing outside this union may reach a wallet.
 */
export type Openid4vciWireError =
  | "invalid_credential_request"
  | "unknown_credential_configuration"
  | "invalid_proof"
  | "invalid_nonce"
  | "credential_request_denied"
  | "invalid_grant"
  | "invalid_request";

/**
 * Internal code to wire code.
 *
 * Every nonce failure becomes `invalid_nonce` and every proof failure becomes
 * `invalid_proof` so that a wallet cannot use the response to distinguish
 * "that nonce was never minted" from "that nonce is spent" — the same
 * no-oracle rule that governs {@link redeemPreAuthorizedCode}. The
 * configuration codes map to `credential_request_denied` because a
 * misconfigured issuer is unrecoverable from the wallet's side, which is
 * exactly what that code tells it.
 */
const WIRE_ERRORS = {
  invalid_issuer_configuration: "credential_request_denied",
  invalid_offer: "invalid_request",
  offer_link_would_leak: "credential_request_denied",
  malformed_proof: "invalid_proof",
  proof_typ_mismatch: "invalid_proof",
  proof_algorithm_not_allowed: "invalid_proof",
  proof_key_reference_invalid: "invalid_proof",
  proof_audience_mismatch: "invalid_proof",
  proof_not_fresh: "invalid_proof",
  proof_issuer_claim_forbidden: "invalid_proof",
  proof_signature_invalid: "invalid_proof",
  nonce_missing: "invalid_proof",
  nonce_unknown: "invalid_nonce",
  nonce_replayed: "invalid_nonce",
  pre_authorized_code_rejected: "invalid_grant",
  forbidden_credential_claim: "credential_request_denied",
  subject_reference_invalid: "credential_request_denied",
  issuance_refused: "credential_request_denied",
} satisfies Readonly<Record<Openid4vciErrorCode, Openid4vciWireError>>;

/**
 * Human-readable text, one constant per code.
 *
 * These are for the operator reading a stack trace. They are safe to log
 * verbatim because no part of them came from the request.
 */
const MESSAGES = {
  invalid_issuer_configuration: "issuer configuration is incomplete or invalid",
  invalid_offer: "credential offer parameters are incomplete or invalid",
  offer_link_would_leak: "offer link would carry credential material",
  malformed_proof: "key proof is not a signed compact JWS",
  proof_typ_mismatch: "key proof is not typed openid4vci-proof+jwt",
  proof_algorithm_not_allowed: "key proof algorithm is not allowed",
  proof_key_reference_invalid: "key proof header key reference is invalid",
  proof_audience_mismatch: "key proof audience is not this credential issuer",
  proof_not_fresh: "key proof issuance time is outside the freshness window",
  proof_issuer_claim_forbidden: "key proof carries an iss claim",
  proof_signature_invalid: "key proof signature did not verify",
  nonce_missing: "key proof carries no nonce",
  nonce_unknown: "key proof nonce is not valid",
  nonce_replayed: "key proof nonce is not valid",
  pre_authorized_code_rejected: "pre-authorized code is not valid",
  forbidden_credential_claim: "credential claim set carries a forbidden claim",
  subject_reference_invalid:
    "subject reference is not an opaque pairwise handle",
  issuance_refused: "credential issuance refused",
} satisfies Readonly<Record<Openid4vciErrorCode, string>>;

export class Openid4vciError extends Error {
  readonly code: Openid4vciErrorCode;
  /** The single value permitted to cross the wire to a wallet. */
  readonly wireError: Openid4vciWireError;

  constructor(code: Openid4vciErrorCode) {
    super(MESSAGES[code]);
    this.name = "Openid4vciError";
    this.code = code;
    this.wireError = WIRE_ERRORS[code];
  }
}

/**
 * Refuse, with a return type of `never`.
 *
 * Declaring `never` is what lets the caller write `if (bad) refuse(...)` and
 * have the compiler narrow afterwards, so a check and its consequence stay on
 * one line and there is no path where a refusal is computed and then dropped.
 */
export function refuse(code: Openid4vciErrorCode): never {
  throw new Openid4vciError(code);
}

/**
 * Run `fn`, converting any escaping error into one of ours.
 *
 * Used around `JSON.parse`, base64url decoding, and `jose` calls — the three
 * places where a foreign error type would otherwise reach the caller carrying
 * request bytes in its message.
 */
export function guarded<T>(code: Openid4vciErrorCode, fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new Openid4vciError(code);
  }
}

/** {@link guarded} for a promise-returning body. */
export async function guardedAsync<T>(
  code: Openid4vciErrorCode,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new Openid4vciError(code);
  }
}

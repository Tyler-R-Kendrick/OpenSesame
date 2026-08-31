/**
 * The only failure type this package throws.
 *
 * A verifier is a parser sitting in front of a trust decision, and parsers
 * leak. `jose` throws `JWSSignatureVerificationFailed`, `JSON.parse` throws
 * `SyntaxError` with the offending byte offset, `Buffer.from` throws on
 * nothing at all and silently truncates instead. Any of those escaping this
 * package would do three bad things at once: hand the caller an error surface
 * that changes when a dependency is bumped, put attacker-authored bytes into
 * whatever log sink catches it, and let the caller's `catch` see the shape of
 * the internal pipeline. So every path out of {@link verifyPresentation} that
 * is not a `VerifiedPresentation` is an `Openid4vpError` with a code from a
 * closed union, and every message is a constant string chosen by this file.
 *
 * **Messages never quote input.** Not the nonce, not a claim name, not the
 * algorithm that was refused, not a truncated prefix of the token. A verifier
 * is reachable by anyone who can POST to the response endpoint, so its error
 * strings are an attacker-controlled write primitive into the operator's logs
 * unless they are constants. What varies between failures is the `code` and
 * the `checkpoint` — both drawn from unions declared here, so a log line can
 * be precise about *where* the refusal happened without repeating *what* was
 * sent.
 *
 * For the same reason no `cause` is attached. Chaining the underlying JOSE
 * error would restore exactly the leak the wrapper exists to prevent, because
 * a caller that logs `err` will format `err.cause` along with it.
 *
 * The guarantee covers the message and the caller's own arguments, which is why
 * {@link verifyPresentation} re-validates both before it does anything else: a
 * route that forwards a parsed request body is promising on the body's behalf,
 * and a body with no `state` used to produce a `TypeError` rather than a
 * refusal. It does **not** cover the injected {@link RequestSessionStore}. A
 * store that cannot reach its database throws its own error and that error
 * propagates unchanged, deliberately: an outage is not a verdict on the
 * presentation, and dressing one up as `malformed_presentation` would tell an
 * operator the sender is at fault when the database is.
 */

/**
 * Stable refusal codes.
 *
 * The first twelve are the contract: they name the checks an OpenID4VP 1.0
 * verifier must be able to fail independently, and callers may switch on them.
 * The remaining four exist because folding them into their nearest neighbour
 * would have been a lie — an untrusted issuer is not a malformed presentation,
 * and a credential that expired yesterday is not a request that expired. Codes
 * are only ever added, never renamed or repurposed.
 */
export type Openid4vpErrorCode =
  /** The KB-JWT's `nonce` is not the nonce this request session issued. */
  | "nonce_mismatch"
  /** No request session for the returned `state`. */
  | "state_unknown"
  /** The KB-JWT's `aud` is not this verifier's Client Identifier. */
  | "audience_mismatch"
  /** A JOSE header named an algorithm outside the allow-list, or none at all. */
  | "algorithm_not_allowed"
  /** The credential format identifier is not one this verifier can check. */
  | "format_not_supported"
  /** The presentation is not provably held by the key the credential names. */
  | "holder_binding_failed"
  /** The signed transaction-data hashes are not exactly the ones requested. */
  | "transaction_data_mismatch"
  /** The settled request is not the one the caller asked about. */
  | "digest_mismatch"
  /** This request session already settled; a second response is a replay. */
  | "presentation_replayed"
  /** The request session lapsed before the response arrived. */
  | "request_expired"
  /** The response arrived by a transport this request did not ask for. */
  | "response_mode_mismatch"
  /** Structurally not a presentation this verifier can parse. */
  | "malformed_presentation"
  /** No allow-listed issuer key verifies the credential signature. */
  | "issuer_untrusted"
  /** The credential's `exp` is in the past. */
  | "credential_expired"
  /** The credential's `nbf` is in the future. */
  | "credential_not_yet_valid"
  /** The credential does not answer the DCQL query it was returned for. */
  | "query_not_satisfied";

/**
 * Where in the pipeline a refusal happened.
 *
 * Deliberately coarser than a line number and drawn from a closed set, so it
 * can be logged and alerted on without becoming a channel for input. Two
 * different codes can share a checkpoint and one code can be raised from
 * several checkpoints; the pair is what identifies a refusal.
 */
export type Openid4vpCheckpoint =
  | "request_construction"
  | "response_envelope"
  | "session_lookup"
  | "response_mode"
  | "request_binding"
  | "vp_token_shape"
  | "credential_format"
  | "presentation_structure"
  | "jose_header"
  | "issuer_signature"
  | "credential_validity"
  | "dcql_match"
  | "disclosure_digest"
  | "key_binding"
  | "nonce_binding"
  | "audience_binding"
  | "transaction_data"
  | "session_consume";

/**
 * Constant text per code.
 *
 * Written to be safe to surface verbatim in an operator log, a metric label,
 * or an incident ticket. None of them tell the sender which check they
 * tripped in more detail than the code already does: a verifier that explains
 * *why* a forged token was rejected is a tutor for the next attempt.
 */
const MESSAGES = {
  nonce_mismatch: "presentation nonce does not match the request session",
  state_unknown: "no request session for the returned state",
  audience_mismatch:
    "presentation audience does not match the client identifier",
  algorithm_not_allowed: "JOSE header algorithm is not permitted",
  format_not_supported: "credential format is not supported by this verifier",
  holder_binding_failed: "key binding could not be established",
  transaction_data_mismatch:
    "signed transaction data does not match the authorized set",
  digest_mismatch: "presentation is bound to a different request",
  presentation_replayed: "request session has already been settled",
  request_expired: "request session expired before the response arrived",
  response_mode_mismatch: "response arrived by an unrequested response mode",
  malformed_presentation: "presentation is not well formed",
  issuer_untrusted: "credential issuer is not trusted by this verifier",
  credential_expired: "credential has expired",
  credential_not_yet_valid: "credential is not yet valid",
  query_not_satisfied: "credential does not satisfy the credential query",
} as const satisfies Record<Openid4vpErrorCode, string>;

/**
 * The single error type crossing this package's boundary.
 *
 * `name` is fixed so `instanceof` is not the only way to recognize one after a
 * structured-clone or a serialization hop.
 */
export class Openid4vpError extends Error {
  readonly code: Openid4vpErrorCode;
  readonly checkpoint: Openid4vpCheckpoint;

  constructor(code: Openid4vpErrorCode, checkpoint: Openid4vpCheckpoint) {
    super(MESSAGES[code]);
    this.name = "Openid4vpError";
    this.code = code;
    this.checkpoint = checkpoint;
  }
}

export function isOpenid4vpError(value: Error): value is Openid4vpError {
  return value instanceof Openid4vpError;
}

/**
 * Refuse, with a return type of `never` so call sites read as guards.
 *
 * Every refusal in this package goes through here, which makes the set of
 * reachable `(code, checkpoint)` pairs greppable.
 */
export function refuse(
  code: Openid4vpErrorCode,
  checkpoint: Openid4vpCheckpoint,
): never {
  throw new Openid4vpError(code, checkpoint);
}

/**
 * Run a step that may throw something from outside this package.
 *
 * Wraps `jose`, `JSON.parse`, `Buffer`, and WebCrypto. An `Openid4vpError`
 * raised inside the step passes through unchanged — the step already decided
 * precisely what went wrong and that decision must not be flattened into the
 * fallback code. Anything else becomes `(fallback, checkpoint)` and the
 * original is dropped on the floor rather than chained, because the original
 * is exactly the object that may quote the input.
 */
export function guarded<T>(
  checkpoint: Openid4vpCheckpoint,
  fallback: Openid4vpErrorCode,
  step: () => T,
): T {
  try {
    return step();
  } catch (thrown) {
    if (thrown instanceof Openid4vpError) throw thrown;
    throw new Openid4vpError(fallback, checkpoint);
  }
}

/** {@link guarded} for a step that awaits — same contract, same discard. */
export async function guardedAsync<T>(
  checkpoint: Openid4vpCheckpoint,
  fallback: Openid4vpErrorCode,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (thrown) {
    if (thrown instanceof Openid4vpError) throw thrown;
    throw new Openid4vpError(fallback, checkpoint);
  }
}

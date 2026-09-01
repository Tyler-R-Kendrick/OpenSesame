/**
 * Key proof verification — the only place a holder's key becomes trusted.
 *
 * Everything this package signs is downstream of this function. `issue.ts`
 * copies the key it returns straight into `cnf.jwk`, which is what a verifier
 * will later demand a signature under. So a mistake here is not "a bad proof
 * was accepted"; it is "OpenSesame signed a statement binding a credential to
 * an attacker's key", and the credential is valid.
 *
 * The checks are ordered, and the order is load-bearing:
 *
 * 1. **Shape, then signature presence.** RFC 7519 §6's unsecured JWT is a
 *    syntactically valid three-part token with an empty third part. Refusing
 *    on shape alone lets it through; refusing on `alg` alone misses a token
 *    that names `ES256` and simply omits the signature.
 * 2. **`typ` before anything else in the header.** RFC 8725 §3.11 explicit
 *    typing is what stops a JWT minted for some other purpose — a device
 *    attestation, a DPoP proof, an ID token — being replayed here. It is
 *    checked before the algorithm so that a foreign token is refused as a
 *    foreign token rather than as a bad algorithm.
 * 3. **Algorithm from an allow-list, never from the token.** `none` is the
 *    obvious case. The subtle one is `HS256`: an attacker MACs the token with
 *    a *public* value and a verifier that passes "the key in the header" plus
 *    "the algorithm in the header" into one call validates it. The defence is
 *    not to inspect the key type afterwards — it is to never let the sender
 *    choose. The allow-list is checked here, and pinned again at import and
 *    at verification, three times from three directions.
 * 4. **Exactly one key reference, and it must be `jwk`.** §Appendix F.1 makes
 *    `kid`, `jwk` and `x5c` mutually exclusive. A token carrying two is not
 *    ambiguous-but-recoverable; it is a token built to be read differently by
 *    two implementations, so it is refused rather than resolved. `kid` and
 *    `x5c` are refused outright because resolving either means trusting
 *    something outside the token — a key registry, a certificate chain — and
 *    this issuer deliberately has no such trust anchor for holders.
 * 5. **Claims before cryptography.** `aud`, `iat` and the presence of `nonce`
 *    are checked before the signature so that the expensive operation is not
 *    reachable by an unauthenticated caller sending garbage in volume.
 * 6. **The signature, against the key the token itself carries.** This is
 *    self-signed by construction and proves exactly one thing: whoever sent
 *    this holds the private half of the key in the header. That is the entire
 *    claim being made, and it is why the key becomes `cnf.jwk` and nothing
 *    more.
 * 7. **The nonce is spent last, only after the signature verified.** Spending
 *    earlier would let anyone who observed a `c_nonce` burn it with a garbage
 *    proof and invalidate a legitimate wallet's in-flight request. A replay of
 *    a *valid* proof still fails, because by then the nonce is spent.
 */

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { type JWK, compactVerify, importJWK } from "jose";
import {
  type Openid4vciErrorCode,
  guarded,
  guardedAsync,
  refuse,
} from "./errors.js";
import { type SupportedAlgorithm, isSupportedAlgorithm } from "./metadata.js";
import type { NonceStore } from "./nonce.js";

/**
 * The registered `typ` for a key proof (OpenID4VCI 1.0 §Appendix F.1, §G.6.1).
 *
 * The bare subtype, not `application/openid4vci-proof+jwt`: RFC 7515 §4.1.9
 * permits omitting the `application/` prefix and the specification's own
 * normative text and examples use the short form. We require the short form
 * exactly — accepting both spellings would mean two byte strings map to one
 * type, which is the beginning of every parser-differential bug.
 */
export const PROOF_JWT_TYP = "openid4vci-proof+jwt";

/**
 * How old a proof may be.
 *
 * Independent of the nonce TTL and deliberately so. The nonce bounds when the
 * *challenge* was minted, which is a fact we know; `iat` bounds when the
 * holder claims to have signed, which is a fact they assert. Neither implies
 * the other, and a proof that satisfies both was made inside a window both
 * parties agree on.
 */
export const DEFAULT_PROOF_MAX_AGE_SECONDS = 300;

/**
 * Tolerance for a holder's clock running ahead.
 *
 * Not zero, because consumer devices drift and a wallet that cannot be issued
 * a credential until its clock is fixed is a wallet that gets told to turn off
 * the check. Not large, because every second here is a second of extra replay
 * window for a proof captured before its nonce was spent.
 */
export const DEFAULT_PROOF_CLOCK_SKEW_SECONDS = 60;

export interface ProofExpectations {
  /** The Credential Issuer Identifier the proof's `aud` must equal. */
  readonly credentialIssuer: string;
  /** Where the `nonce` is spent. Consumed only on an otherwise-valid proof. */
  readonly nonceStore: NonceStore;
  /** Defaults to {@link SUPPORTED_ALGORITHMS}; may only narrow it. */
  readonly allowedAlgorithms?: readonly SupportedAlgorithm[];
  readonly maxAgeSeconds?: number;
  readonly clockSkewSeconds?: number;
  readonly now?: Date;
}

export interface VerifiedProof {
  /**
   * The holder's public key, rebuilt from scratch.
   *
   * Not the JWK object the wallet sent. See {@link canonicalHolderJwk}: this
   * contains only the members required to verify a signature, in a fixed
   * order, and nothing else the wallet put in the header.
   */
  readonly holderJwk: JWK;
  readonly algorithm: SupportedAlgorithm;
  /** The spent `c_nonce`. Returned so a caller can correlate, not re-check. */
  readonly nonce: string;
  /** `iat`, in seconds, as asserted by the holder and accepted by us. */
  readonly issuedAt: number;
}

/** RFC 4648 §5 alphabet, unpadded, non-empty. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Strict base64url decode.
 *
 * `Buffer.from(s, "base64url")` accepts padding, standard-alphabet
 * characters, whitespace and trailing garbage, discarding silently what it
 * cannot use. That turns several distinct strings into one value — and this
 * function's output is parsed as the header that decides how the token is
 * treated, so a lenient decoder means an attacker has several spellings of one
 * header and a downstream parser may not agree with us about which one it saw.
 */
function decodeBase64url(segment: string, code: Openid4vciErrorCode): Buffer {
  if (!BASE64URL.test(segment)) refuse(code);
  return Buffer.from(segment, "base64url");
}

function parseJsonObject(bytes: Buffer, code: Openid4vciErrorCode): JsonObject {
  return guarded(code, () => {
    const parsed: JsonValue = JSON.parse(bytes.toString("utf8"));
    if (!isJsonObject(parsed)) throw new SyntaxError("not an object");
    return parsed;
  });
}

/**
 * Rebuild the holder's key from only the members that verify a signature.
 *
 * The wallet chose the bytes of the `jwk` header, and whatever we return here
 * is copied verbatim into an issuer-signed credential. A JWK is an open JSON
 * object, so passing it through would let a wallet have OpenSesame sign an
 * arbitrary string of its choosing — a tracking identifier, a URL, a note to a
 * future verifier — carried inside `cnf` and indistinguishable from key
 * material. Rebuilding from a fixed member list closes that: the credential
 * carries the key and only the key.
 *
 * It also makes the private-key case unreachable rather than merely checked. A
 * wallet that sends `d` alongside `x`/`y` (a real bug in shipped software)
 * cannot have it land in `cnf`, because `d` is not a member we copy. The
 * explicit refusal below is still there, because signing a credential for a
 * key whose private half was just posted to us in plaintext is something an
 * operator should hear about rather than have quietly cleaned up.
 */
function canonicalHolderJwk(
  header: JsonObject,
  algorithm: SupportedAlgorithm,
): JWK {
  const jwk = header.jwk;
  if (!isJsonObject(jwk)) refuse("proof_key_reference_invalid");

  // Any private or symmetric member at all. `d` is the EC/OKP private scalar,
  // `k` a symmetric key, the rest are RSA CRT parameters.
  for (const member of ["d", "k", "p", "q", "dp", "dq", "qi"]) {
    if (jwk[member] !== undefined) refuse("proof_key_reference_invalid");
  }

  const kty = jwk.kty;
  const crv = jwk.crv;
  const x = jwk.x;
  if (!isString(kty) || !isString(crv) || !isString(x)) {
    refuse("proof_key_reference_invalid");
  }

  // The curve is pinned to the algorithm rather than read from the key. A
  // P-521 key presented as `ES256` is not an interoperability quirk to be
  // accommodated; it is a mismatch between what the token says it is and what
  // it contains, and there is exactly one right pairing for each algorithm.
  if (algorithm === "ES256") {
    if (kty !== "EC" || crv !== "P-256") refuse("proof_key_reference_invalid");
    const y = jwk.y;
    if (!isString(y)) refuse("proof_key_reference_invalid");
    if (!BASE64URL.test(x) || !BASE64URL.test(y)) {
      refuse("proof_key_reference_invalid");
    }
    return { kty, crv, x, y };
  }

  if (kty !== "OKP" || crv !== "Ed25519") refuse("proof_key_reference_invalid");
  if (!BASE64URL.test(x)) refuse("proof_key_reference_invalid");
  return { kty, crv, x };
}

/**
 * Verify a `jwt` key proof and return the key it binds.
 *
 * Throws `Openid4vciError` for every failure; there is no falsy return, so a
 * caller cannot proceed past a refusal by forgetting a check.
 */
export async function verifyProofOfPossession(
  proofJwt: string,
  expected: ProofExpectations,
): Promise<VerifiedProof> {
  if (!isString(proofJwt) || proofJwt.length === 0) refuse("malformed_proof");

  const segments = proofJwt.split(".");
  if (segments.length !== 3) refuse("malformed_proof");
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    refuse("malformed_proof");
  }
  // The wire form of an unsecured JWT: well-formed, and an explicit assertion
  // that no key was used. Refused as an algorithm failure, not a shape one.
  if (signatureSegment.length === 0) refuse("proof_algorithm_not_allowed");

  const header = parseJsonObject(
    decodeBase64url(headerSegment, "malformed_proof"),
    "malformed_proof",
  );

  if (!isString(header.typ) || header.typ !== PROOF_JWT_TYP) {
    refuse("proof_typ_mismatch");
  }

  // We implement no JOSE header extensions, so no value of `crit` could be
  // satisfied. RFC 7515 §4.1.11 says an unsatisfiable `crit` must be refused;
  // for an implementation with an empty extension set that means all of them.
  if (header.crit !== undefined) refuse("proof_algorithm_not_allowed");

  const algorithm = header.alg;
  if (!isString(algorithm) || !isSupportedAlgorithm(algorithm)) {
    // Covers `none`, every `HS*`, every RSA variant, a missing `alg`, and an
    // `alg` that is not a string. One refusal, and no branch that tells the
    // sender which of those it was.
    refuse("proof_algorithm_not_allowed");
  }
  const allowed = expected.allowedAlgorithms;
  if (allowed !== undefined && !allowed.includes(algorithm)) {
    refuse("proof_algorithm_not_allowed");
  }

  // §Appendix F.1: `kid`, `jwk` and `x5c` are mutually exclusive. This issuer
  // supports only `jwk`, so the check is "exactly one, and it is jwk".
  if (header.kid !== undefined || header.x5c !== undefined) {
    refuse("proof_key_reference_invalid");
  }
  const holderJwk = canonicalHolderJwk(header, algorithm);

  const payload = parseJsonObject(
    decodeBase64url(payloadSegment, "malformed_proof"),
    "malformed_proof",
  );

  // §Appendix F.1: `iss` "MUST be omitted if the access token authorizing the
  // issuance call was obtained from a Pre-Authorized Code Flow through
  // anonymous access to the token endpoint." That is the only flow this
  // package implements, so a proof carrying `iss` is a proof built for a
  // different deployment and is refused rather than ignored.
  if (payload.iss !== undefined) refuse("proof_issuer_claim_forbidden");

  const audience = payload.aud;
  if (!isString(audience) || audience !== expected.credentialIssuer) {
    refuse("proof_audience_mismatch");
  }

  const issuedAt = payload.iat;
  if (!isNumber(issuedAt) || !Number.isFinite(issuedAt)) {
    refuse("proof_not_fresh");
  }
  const nowSeconds = Math.floor((expected.now ?? new Date()).getTime() / 1000);
  const maxAge = expected.maxAgeSeconds ?? DEFAULT_PROOF_MAX_AGE_SECONDS;
  const skew = expected.clockSkewSeconds ?? DEFAULT_PROOF_CLOCK_SKEW_SECONDS;
  if (issuedAt > nowSeconds + skew) refuse("proof_not_fresh");
  if (issuedAt < nowSeconds - maxAge) refuse("proof_not_fresh");

  const nonce = payload.nonce;
  if (!isString(nonce) || nonce.length === 0) refuse("nonce_missing");

  // Three independent pins on the algorithm: the allow-list above, the key
  // imported *as* that algorithm so the material cannot be handed to a
  // different primitive, and `algorithms: [algorithm]` telling `jose` this
  // call accepts exactly one.
  const key = await guardedAsync("proof_key_reference_invalid", () =>
    importJWK(holderJwk, algorithm),
  );
  await guardedAsync("proof_signature_invalid", () =>
    compactVerify(proofJwt, key, { algorithms: [algorithm] }),
  );

  // Last. See the file header: spending before the signature verified would
  // let anyone who saw a `c_nonce` invalidate a legitimate wallet's proof.
  await expected.nonceStore.consume(nonce, expected.now);

  return { holderJwk, algorithm, nonce, issuedAt };
}

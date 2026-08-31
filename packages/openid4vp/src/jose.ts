/**
 * The JOSE fence.
 *
 * Nothing in this package hands a token to a signature routine before it has
 * been through {@link readSignedCompactJws}. The reason is that every famous
 * JWT break is a *policy* failure that happens strictly before the maths:
 *
 * - `alg: none` — the token declares it needs no key, and a library that
 *   dispatches on the header obliges. `jose` refuses these itself, but relying
 *   on that would mean the rule lives in a dependency's changelog rather than
 *   in our code, so this file refuses first and by name.
 * - `alg: HS256` against an asymmetric verifier — the attacker MACs the token
 *   with the *public* key, and a verifier that passes "the key for this
 *   issuer" plus "the algorithm the token asked for" into one call validates
 *   it. The defence is not to check the key type afterwards; it is never to
 *   let the sender choose the algorithm at all. Here the allow-list is checked
 *   against the header, and then again against the `alg` declared on the
 *   trusted key, so the algorithm is pinned twice from two directions.
 * - unknown `crit` — RFC 7515 §4.1.11 says a header extension listed in
 *   `crit` must be understood or the token rejected. Ignoring it means a
 *   future extension that *narrows* a token's meaning is silently discarded
 *   and the token is accepted more broadly than its signer intended. We
 *   understand no extensions, so any `crit` at all is a refusal.
 *
 * The allow-list itself is elliptic-curve and Edwards only. RSA is absent
 * because nothing in the OpenID4VP wallet ecosystem this verifier targets
 * needs it and its presence would widen the parameter surface (PSS salt
 * lengths, key sizes, Bleichenbacher-adjacent padding checks) for no gain.
 */

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { type JWK, compactVerify, importJWK } from "jose";
import { decodeBase64url, decodeUtf8 } from "./encoding.js";
import {
  type Openid4vpCheckpoint,
  guarded,
  guardedAsync,
  refuse,
} from "./errors.js";

/**
 * Signature algorithms this verifier will accept in any JOSE header.
 *
 * `ES256` is the interoperability floor — OpenID4VP §B.3.4's own examples
 * advertise it for both the issuer-signed JWT and the KB-JWT, and every HAIP
 * profile requires it. `ES384` and `EdDSA` are here because deployments that
 * standardized on P-384 or Ed25519 should not have to fork the package.
 */
export const SUPPORTED_SIGNATURE_ALGORITHMS = [
  "ES256",
  "ES384",
  "EdDSA",
] as const;

export type SupportedSignatureAlgorithm =
  (typeof SUPPORTED_SIGNATURE_ALGORITHMS)[number];

export function isSupportedSignatureAlgorithm(
  value: string,
): value is SupportedSignatureAlgorithm {
  return SUPPORTED_SIGNATURE_ALGORITHMS.some(
    (candidate) => candidate === value,
  );
}

/**
 * `typ` values this package expects, by position.
 *
 * Explicit typing is RFC 8725 §3.11's answer to cross-protocol confusion: a
 * KB-JWT must not be accepted where an issuer-signed credential is expected,
 * and neither may stand in for a signed authorization request. Each of the
 * three has a registered media type and this package checks it.
 */
export const KEY_BINDING_JWT_TYP = "kb+jwt";
export const REQUEST_OBJECT_TYP = "oauth-authz-req+jwt";
/**
 * SD-JWT VC typed both ways.
 *
 * `dc+sd-jwt` is the current identifier; `vc+sd-jwt` was used through draft -05
 * and draft-ietf-oauth-sd-jwt-vc-18 §2.2.1 explicitly recommends that verifiers
 * accept both "for a reasonable transitional period". Accepting the legacy
 * spelling costs nothing — the digests, signature, and binding checks are
 * identical. (§2.2.1 is that revision's numbering; the same paragraph was
 * §3.2.1 in -11, which is the citation this comment used to carry.)
 */
export const SD_JWT_VC_TYPS: readonly string[] = ["dc+sd-jwt", "vc+sd-jwt"];

/**
 * A compact JWS that has passed header policy but not yet the signature check.
 *
 * The segments are retained because the signature is computed over the exact
 * received bytes of `protectedHeader.payload`; re-serializing the parsed
 * header would change them.
 */
export interface CheckedCompactJws {
  readonly alg: SupportedSignatureAlgorithm;
  readonly typ: string | null;
  readonly kid: string | null;
  readonly header: JsonObject;
  readonly payload: JsonObject;
  /** The received serialization, byte-for-byte. */
  readonly compact: string;
}

function parseJsonObject(text: string): JsonObject {
  const parsed: JsonValue = JSON.parse(text);
  if (!isJsonObject(parsed)) throw new SyntaxError("not a JSON object");
  return parsed;
}

/**
 * Parse a compact JWS and enforce header policy.
 *
 * Order matters and is deliberate: shape, then *presence of a signature*, then
 * algorithm, then `crit`, then `typ`. The signature-presence check sits second
 * because an unsecured JWT (RFC 7519 §6) is syntactically a valid three-part
 * token with an empty third part — refusing it on shape alone would let it
 * through, and refusing it on `alg` alone would miss a token that names
 * `ES256` and simply omits the signature.
 */
export function readSignedCompactJws(
  compact: string,
  expectedTyp: readonly string[] | null,
  checkpoint: Openid4vpCheckpoint,
): CheckedCompactJws {
  const segments = compact.split(".");
  if (segments.length !== 3) {
    refuse("malformed_presentation", checkpoint);
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    refuse("malformed_presentation", checkpoint);
  }
  // An empty signature segment is the wire form of an unsecured JWT. It is not
  // a malformed token — it is a well-formed assertion that no key was used,
  // which is precisely the thing a verifier must never accept.
  if (signatureSegment.length === 0) {
    refuse("algorithm_not_allowed", "jose_header");
  }

  const header = guarded(checkpoint, "malformed_presentation", () =>
    parseJsonObject(decodeUtf8(decodeBase64url(headerSegment))),
  );
  const payload = guarded(checkpoint, "malformed_presentation", () =>
    parseJsonObject(decodeUtf8(decodeBase64url(payloadSegment))),
  );

  const alg = header.alg;
  if (!isString(alg) || !isSupportedSignatureAlgorithm(alg)) {
    // Covers `none`, every `HS*`, every RSA variant, a missing `alg`, and an
    // `alg` that is not even a string — one refusal, no branch that tells the
    // sender which of those it was.
    refuse("algorithm_not_allowed", "jose_header");
  }

  if (header.crit !== undefined) {
    // We implement no header extensions, so there is no value of `crit` that
    // could be satisfied. Refusing unconditionally is the honest reading of
    // RFC 7515 §4.1.11 for an implementation with an empty extension set.
    refuse("algorithm_not_allowed", "jose_header");
  }

  const typ = isString(header.typ) ? header.typ : null;
  if (expectedTyp !== null) {
    if (typ === null || !expectedTyp.includes(typ)) {
      refuse("malformed_presentation", "jose_header");
    }
  }

  return {
    alg,
    typ,
    kid: isString(header.kid) ? header.kid : null,
    header,
    payload,
    compact,
  };
}

/**
 * Verify a checked JWS against one public key.
 *
 * Two independent pins on the algorithm:
 *
 * 1. `algorithms: [checked.alg]` tells `jose` that this call accepts exactly
 *    the one algorithm the header declared — and `checked.alg` is already
 *    known to be in the allow-list.
 * 2. `importJWK(jwk, checked.alg)` binds the key material to that algorithm at
 *    import time, so a P-256 key cannot be handed to an HMAC verifier even if
 *    the first pin were somehow bypassed.
 *
 * The caller is expected to have selected `jwk` by matching its own declared
 * `alg`, which is the third pin and the one that actually stops algorithm
 * confusion: the key says what it may be used for, and the token does not get
 * a vote.
 */
export async function verifyCompactJws(
  checked: CheckedCompactJws,
  jwk: JWK,
  failure: "issuer_untrusted" | "holder_binding_failed",
  checkpoint: Openid4vpCheckpoint,
): Promise<void> {
  await guardedAsync(checkpoint, failure, async () => {
    const key = await importJWK(jwk, checked.alg);
    await compactVerify(checked.compact, key, { algorithms: [checked.alg] });
  });
}

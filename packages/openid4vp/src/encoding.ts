/**
 * Byte-level primitives every other file in this package shares.
 *
 * Three of them carry security weight and are worth reading before the
 * protocol code that uses them:
 *
 * - **base64url decoding is strict.** Node's `Buffer.from(s, "base64url")`
 *   accepts padding, standard-alphabet characters, whitespace, and trailing
 *   garbage, silently discarding what it cannot use. That turns "two different
 *   strings" into "one value" — and this package hashes strings that a wallet
 *   chose, so a lenient decoder means an attacker has several spellings of the
 *   same disclosure and the digest set stops being a set. Everything is
 *   validated against the RFC 4648 §5 alphabet first.
 * - **hash algorithms come from a closed union.** OpenID4VP and SD-JWT both
 *   let the sender name the hash (`transaction_data_hashes_alg`, `_sd_alg`)
 *   using IANA "Hash Name String" identifiers. A sender-named algorithm is a
 *   downgrade lever unless the receiver holds a list, so this file holds it.
 * - **string equality for secrets is double-HMAC.** See
 *   {@link constantTimeEquals}.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Hash identifiers this verifier will accept from a wallet.
 *
 * Values are from the IANA "Named Information Hash Algorithm" registry, which
 * is what both OpenID4VP 1.0 §B.3.3.1 and RFC 9901 §4.1.1 point at. SHA-1 and
 * the truncated SHA-2 variants are absent on purpose: the registry contains
 * them, and a wallet that gets to pick `sha-1` picks the collision budget for
 * our disclosure digests.
 */
export const SUPPORTED_HASH_ALGORITHMS = [
  "sha-256",
  "sha-384",
  "sha-512",
] as const;

export type HashAlgorithm = (typeof SUPPORTED_HASH_ALGORITHMS)[number];

/**
 * The default both specifications mandate when the sender names no algorithm.
 *
 * RFC 9901 §4.1.1: an SD-JWT without `_sd_alg` is `sha-256`. OpenID4VP
 * §B.3.3.1: transaction data without `transaction_data_hashes_alg` is
 * `sha-256`. Same constant, two specs, one place.
 */
export const DEFAULT_HASH_ALGORITHM: HashAlgorithm = "sha-256";

const NODE_DIGEST_NAMES = {
  "sha-256": "sha256",
  "sha-384": "sha384",
  "sha-512": "sha512",
} as const satisfies Record<HashAlgorithm, string>;

export function isHashAlgorithm(value: string): value is HashAlgorithm {
  return SUPPORTED_HASH_ALGORITHMS.some((candidate) => candidate === value);
}

/** RFC 4648 §5 alphabet, no padding, at least one character. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function isBase64url(value: string): boolean {
  return BASE64URL.test(value);
}

export function encodeBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Decode base64url, or throw.
 *
 * Throwing (rather than returning `undefined`) keeps call sites inside the
 * `guarded` wrappers that already exist for `JSON.parse`, so a malformed
 * segment lands on the same typed refusal as malformed JSON instead of
 * needing its own branch at every use.
 */
export function decodeBase64url(value: string): Uint8Array {
  if (!BASE64URL.test(value)) {
    throw new SyntaxError("not base64url");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  // A base64url string whose length mod 4 is 1 cannot encode any byte string;
  // Node returns a short buffer for it instead of failing. Reject explicitly,
  // otherwise two distinct strings decode to the same bytes.
  if (bytes.length === 0 || value.length % 4 === 1) {
    throw new SyntaxError("not base64url");
  }
  return bytes;
}

export function encodeUtf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

export function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Digest of the US-ASCII bytes of a string, base64url encoded.
 *
 * This exact shape is what both specifications ask for and the "US-ASCII
 * bytes" part is load-bearing in each. RFC 9901 §4.2.3: the input to the hash
 * is the base64url-encoded disclosure, *not* the bytes it encodes.
 * OpenID4VP §B.3.3.1: the input is the string received in `transaction_data`,
 * with "base64url decoding is not performed before hashing". Decoding first
 * would produce a digest that matches nothing a wallet ever computes.
 */
export function hashStringToBase64url(
  alg: HashAlgorithm,
  input: string,
): string {
  return createHash(NODE_DIGEST_NAMES[alg])
    .update(Buffer.from(input, "utf8"))
    .digest("base64url");
}

/** base64url of the UTF-8 bytes of a string — the transport encoding for JSON. */
export function encodeStringBase64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** `byteLength` bytes of CSPRNG output, base64url encoded, no padding. */
export function randomBase64url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

/**
 * Per-process key for {@link constantTimeEquals}.
 *
 * Never leaves this module and is regenerated on every start, so the digests
 * it produces are meaningless outside a single comparison.
 */
const COMPARISON_KEY = randomBytes(32);

/**
 * Compare two strings without leaking their contents through timing.
 *
 * The obvious implementation — length check, then `timingSafeEqual` — leaks
 * the length, and `timingSafeEqual` *throws* on unequal lengths, so the length
 * check is not optional. That matters here because the values compared are a
 * nonce and an audience supplied by whoever POSTed to the response endpoint,
 * and an attacker who can distinguish "wrong length" from "wrong bytes" can
 * search the length first and the bytes second.
 *
 * HMAC-ing both sides under a random per-process key first collapses every
 * input to 32 bytes, so the comparison is over fixed-length data and the only
 * observable is equal/not-equal. The key never leaves the process and lives
 * one process lifetime, so the digests are not useful anywhere else.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = createHmac("sha256", COMPARISON_KEY).update(left, "utf8").digest();
  const b = createHmac("sha256", COMPARISON_KEY).update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

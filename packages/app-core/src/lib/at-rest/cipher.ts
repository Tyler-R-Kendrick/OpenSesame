/**
 * The at-rest seal (ADR 0148): what every value the app leaves in a browser
 * store looks like on disk.
 *
 * `osr1.` then base64url of a 24-byte random nonce and the XChaCha20-Poly1305
 * ciphertext with its tag. The associated data names where the value lives
 * (store and key), so a sealed value copied under another name does not
 * open. Synchronous, because Web Storage is: the cipher is `@noble/ciphers`,
 * not SubtleCrypto.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";

/** The start of every sealed value. Anything else is a legacy plaintext value. */
export const AT_REST_PREFIX = "osr1.";

/** The data key's length, in bytes. */
export const AT_REST_KEY_BYTES = 32;

const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function isSealedAtRest(value: string): boolean {
  return value.startsWith(AT_REST_PREFIX);
}

/** Where a value lives, as the associated data its seal is bound to. */
export function atRestBinding(store: string, name: string): Uint8Array {
  return encoder.encode(`opensesame.at-rest.v1\u0000${store}\u0000${name}`);
}

export function sealAtRest(
  key: Uint8Array,
  binding: Uint8Array,
  plaintext: string,
): string {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = xchacha20poly1305(key, nonce, binding).encrypt(
    encoder.encode(plaintext),
  );
  const out = new Uint8Array(NONCE_BYTES + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE_BYTES);
  return `${AT_REST_PREFIX}${bytesToB64url(out)}`;
}

/**
 * The plaintext of a sealed value, or null when it does not open under this
 * key and binding — tampered, moved, or sealed by a key this device no
 * longer holds. Never throws on hostile input.
 */
export function openAtRest(
  key: Uint8Array,
  binding: Uint8Array,
  value: string,
): string | null {
  if (!isSealedAtRest(value)) return null;
  try {
    const bytes = b64urlToBytes(value.slice(AT_REST_PREFIX.length));
    if (bytes.length < NONCE_BYTES + TAG_BYTES) return null;
    const nonce = bytes.subarray(0, NONCE_BYTES);
    const body = bytes.subarray(NONCE_BYTES);
    return decoder.decode(xchacha20poly1305(key, nonce, binding).decrypt(body));
  } catch {
    return null;
  }
}

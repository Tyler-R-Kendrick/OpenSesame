/** Synchronous record envelopes for browser and native application stores. */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";

export const AT_REST_PREFIX = "osr2.";
export const LEGACY_AT_REST_PREFIX = "osr1.";
export const AT_REST_KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const WRAPPED_BYTES = AT_REST_KEY_BYTES + TAG_BYTES;
const HEADER_BYTES = NONCE_BYTES * 2 + WRAPPED_BYTES;
export const AT_REST_OVERHEAD_BYTES = HEADER_BYTES + TAG_BYTES;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function isSealedAtRest(value: string): boolean {
  return /^osr[0-9]+\./u.test(value);
}

/** JSON frames store and record names without delimiter collisions. */
export function atRestBinding(store: string, name: string): Uint8Array {
  return encoder.encode(JSON.stringify(["opensesame.at-rest.v2", store, name]));
}

function wrappingKey(key: Uint8Array, binding: Uint8Array): Uint8Array {
  if (key.length !== AT_REST_KEY_BYTES)
    throw new Error("Invalid at-rest root length");
  return hkdf(
    sha256,
    key,
    encoder.encode("opensesame.at-rest.v2.kek"),
    binding,
    32,
  );
}

function associatedData(binding: Uint8Array, purpose: string): Uint8Array {
  return encoder.encode(
    JSON.stringify(["osr2", purpose, bytesToB64url(binding)]),
  );
}

export function sealAtRest(
  key: Uint8Array,
  binding: Uint8Array,
  plaintext: string,
): string {
  const dek = crypto.getRandomValues(new Uint8Array(AT_REST_KEY_BYTES));
  const kek = wrappingKey(key, binding);
  try {
    const wrapNonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const wrapped = xchacha20poly1305(
      kek,
      wrapNonce,
      associatedData(binding, "wrap"),
    ).encrypt(dek);
    const sealed = xchacha20poly1305(
      dek,
      nonce,
      associatedData(binding, "data"),
    ).encrypt(encoder.encode(plaintext));
    const out = new Uint8Array(HEADER_BYTES + sealed.length);
    out.set(wrapNonce);
    out.set(wrapped, NONCE_BYTES);
    out.set(nonce, NONCE_BYTES + WRAPPED_BYTES);
    out.set(sealed, HEADER_BYTES);
    return `${AT_REST_PREFIX}${bytesToB64url(out)}`;
  } finally {
    dek.fill(0);
    kek.fill(0);
  }
}

/** Convert only our canonical binding into the historical associated data. */
function legacyBinding(binding: Uint8Array): Uint8Array {
  const decoded = decoder.decode(binding);
  if (decoded.startsWith("opensesame.at-rest.v1\u0000")) return binding;
  const parts: BoundaryValue = JSON.parse(decoded);
  if (
    !Array.isArray(parts) ||
    parts.length !== 3 ||
    parts[0] !== "opensesame.at-rest.v2" ||
    !parts.every(isString) ||
    !isString(parts[1]) ||
    !isString(parts[2]) ||
    parts[1].includes("\u0000") ||
    parts[2].includes("\u0000")
  ) {
    throw new Error("Invalid legacy record binding");
  }
  return encoder.encode(
    `opensesame.at-rest.v1\u0000${parts[1]}\u0000${parts[2]}`,
  );
}

/** Returns null on malformed envelopes, wrong roots, or transplanted records. */
export function openAtRest(
  key: Uint8Array,
  binding: Uint8Array,
  value: string,
): string | null {
  try {
    if (value.startsWith(LEGACY_AT_REST_PREFIX)) {
      const bytes = b64urlToBytes(value.slice(LEGACY_AT_REST_PREFIX.length));
      if (bytes.length < NONCE_BYTES + TAG_BYTES) return null;
      return decoder.decode(
        xchacha20poly1305(
          key,
          bytes.subarray(0, NONCE_BYTES),
          legacyBinding(binding),
        ).decrypt(bytes.subarray(NONCE_BYTES)),
      );
    }
    if (!value.startsWith(AT_REST_PREFIX)) return null;
    const bytes = b64urlToBytes(value.slice(AT_REST_PREFIX.length));
    if (bytes.length < HEADER_BYTES + TAG_BYTES) return null;
    const kek = wrappingKey(key, binding);
    let dek: Uint8Array | undefined;
    try {
      dek = xchacha20poly1305(
        kek,
        bytes.subarray(0, NONCE_BYTES),
        associatedData(binding, "wrap"),
      ).decrypt(bytes.subarray(NONCE_BYTES, NONCE_BYTES + WRAPPED_BYTES));
      return decoder.decode(
        xchacha20poly1305(
          dek,
          bytes.subarray(NONCE_BYTES + WRAPPED_BYTES, HEADER_BYTES),
          associatedData(binding, "data"),
        ).decrypt(bytes.subarray(HEADER_BYTES)),
      );
    } finally {
      kek.fill(0);
      dek?.fill(0);
    }
  } catch {
    return null;
  }
}

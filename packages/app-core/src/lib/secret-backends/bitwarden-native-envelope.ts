import { cbc } from "@noble/ciphers/aes";
import { equalBytes } from "@noble/ciphers/utils";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core/bytes.js";
import { z } from "zod";
import { stretchBitwardenMasterKey } from "./bitwarden-native-kdf.js";

/** Allocation policy for this codec, not a provider-wide size guarantee. */
export const MAX_BITWARDEN_FIELD_BYTES = 4 * 1024 * 1024;
export const MAX_BITWARDEN_ACCOUNT_KEY_BYTES = 4096;
const OPEN_ERROR = "Bitwarden ciphertext could not be opened.";

function cipherLimit(plaintextLimit: number): number {
  return (Math.floor(plaintextLimit / 16) + 1) * 16;
}

function base64Limit(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function decodePart(part: string, maximumBytes: number): Uint8Array {
  if (
    !part.length ||
    part.length % 4 ||
    part.length > base64Limit(maximumBytes)
  )
    throw new Error(OPEN_ERROR);
  const bytes = b64ToBytes(part);
  // The shared decoder accepts atob-compatible input; this wire boundary
  // requires canonical padded RFC4648, including zero unused trailing bits.
  if (bytes.length > maximumBytes || bytesToB64(bytes) !== part)
    throw new Error(OPEN_ERROR);
  return bytes;
}

function parseParts(
  text: string,
  type: "0" | "2",
  maximumPlaintext: number,
): string[] {
  const maximumWire =
    2 + 24 + 1 + base64Limit(cipherLimit(maximumPlaintext)) + 45;
  if (!z.string().min(1).max(maximumWire).safeParse(text).success)
    throw new Error(OPEN_ERROR);
  if (!text.startsWith(`${type}.`)) throw new Error(OPEN_ERROR);
  const parts = text.slice(2).split("|");
  if (parts.length !== (type === "2" ? 3 : 2)) throw new Error(OPEN_ERROR);
  return parts;
}

function decodeCipher(parts: string[], maximumPlaintext: number) {
  const iv = decodePart(parts[0], 16);
  const ciphertext = decodePart(parts[1], cipherLimit(maximumPlaintext));
  if (iv.length !== 16 || !ciphertext.length || ciphertext.length % 16)
    throw new Error(OPEN_ERROR);
  return { iv, ciphertext };
}

function decryptBounded(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  maximumPlaintext: number,
): Uint8Array {
  const plaintext = cbc(key, iv).decrypt(ciphertext);
  if (plaintext.length > maximumPlaintext) {
    plaintext.fill(0);
    throw new Error(OPEN_ERROR);
  }
  return plaintext;
}

function openAuthenticated(
  text: string,
  key: Uint8Array,
  maximumPlaintext: number,
): Uint8Array {
  const parts = parseParts(text, "2", maximumPlaintext);
  const { iv, ciphertext } = decodeCipher(parts, maximumPlaintext);
  const receivedMac = decodePart(parts[2], 32);
  if (receivedMac.length !== 32) throw new Error(OPEN_ERROR);
  const expectedMac = hmac
    .create(sha256, key.subarray(32))
    .update(iv)
    .update(ciphertext)
    .digest();
  try {
    // Authenticate the raw IV and ciphertext before any CBC decryption.
    if (!equalBytes(receivedMac, expectedMac)) throw new Error(OPEN_ERROR);
    return decryptBounded(
      key.subarray(0, 32),
      iv,
      ciphertext,
      maximumPlaintext,
    );
  } finally {
    expectedMac.fill(0);
  }
}

/** Type2 field/item-key reader only. Caller owns the returned plaintext. */
export function openBitwardenEncString(
  text: string,
  key64: Uint8Array,
): Uint8Array {
  let key: Uint8Array | undefined;
  try {
    if (!(key64 instanceof Uint8Array) || key64.length !== 64)
      throw new Error(OPEN_ERROR);
    key = new Uint8Array(key64);
    return openAuthenticated(text, key, MAX_BITWARDEN_FIELD_BYTES);
  } catch {
    throw new Error(OPEN_ERROR);
  } finally {
    key?.fill(0);
  }
}

/** Fresh-IV authenticated type2 writer; no unauthenticated writer is exposed. */
export function sealBitwardenEncString(
  plaintext: Uint8Array,
  key64: Uint8Array,
): string {
  let key: Uint8Array | undefined;
  let ownPlaintext: Uint8Array | undefined;
  try {
    if (
      !(plaintext instanceof Uint8Array) ||
      plaintext.length > MAX_BITWARDEN_FIELD_BYTES ||
      !(key64 instanceof Uint8Array) ||
      key64.length !== 64
    )
      throw new Error("Invalid Bitwarden encryption input.");
    key = new Uint8Array(key64);
    ownPlaintext = new Uint8Array(plaintext);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const ciphertext = cbc(key.subarray(0, 32), iv).encrypt(ownPlaintext);
    const mac = hmac
      .create(sha256, key.subarray(32))
      .update(iv)
      .update(ciphertext)
      .digest();
    return `2.${bytesToB64(iv)}|${bytesToB64(ciphertext)}|${bytesToB64(mac)}`;
  } catch {
    throw new Error("Bitwarden ciphertext could not be sealed.");
  } finally {
    key?.fill(0);
    ownPlaintext?.fill(0);
  }
}

/**
 * Account-key unwrap only: type2 or legacy read-only type0 with raw master32.
 * Returns all bounded envelope bytes, including 65+ byte key representations.
 * This does not validate a V1/COSE key or establish an authenticated account;
 * legacy type0 must be bound to authenticated account metadata downstream.
 */
export function openBitwardenAccountKeyEnvelope(
  text: string,
  master32: Uint8Array,
): Uint8Array {
  let master: Uint8Array | undefined;
  let stretched: Uint8Array | undefined;
  try {
    if (!(master32 instanceof Uint8Array) || master32.length !== 32)
      throw new Error(OPEN_ERROR);
    master = new Uint8Array(master32);
    if (z.string().safeParse(text).success && text.startsWith("0.")) {
      const parts = parseParts(text, "0", MAX_BITWARDEN_ACCOUNT_KEY_BYTES);
      const { iv, ciphertext } = decodeCipher(
        parts,
        MAX_BITWARDEN_ACCOUNT_KEY_BYTES,
      );
      return decryptBounded(
        master,
        iv,
        ciphertext,
        MAX_BITWARDEN_ACCOUNT_KEY_BYTES,
      );
    }
    stretched = stretchBitwardenMasterKey(master);
    return openAuthenticated(text, stretched, MAX_BITWARDEN_ACCOUNT_KEY_BYTES);
  } catch {
    throw new Error(OPEN_ERROR);
  } finally {
    master?.fill(0);
    stretched?.fill(0);
  }
}

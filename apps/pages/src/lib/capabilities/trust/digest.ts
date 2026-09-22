/**
 * Digests and encodings shared by the trust modules (S03).
 *
 * WebCrypto SHA-256 over the repo's canonical JSON (sorted keys, no
 * insignificant whitespace — `lib/vault/protection/canonicalize.ts`), so an
 * envelope signed by an operator tool that canonicalizes the same way
 * verifies here byte for byte.
 */
import { type JsonValue, isString } from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/sdk-browser";
import { canonicalizeToBytes } from "../../vault/protection/canonicalize.js";

export const DIGEST_PREFIX = "sha256:";
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return bytesToHex(new Uint8Array(digest));
}

/** `sha256:<hex>` over the canonical form of a JSON body. */
export async function canonicalDigest(value: JsonValue): Promise<string> {
  return `${DIGEST_PREFIX}${await sha256Hex(canonicalizeToBytes(value))}`;
}

export function isDigest(value: JsonValue | undefined): value is string {
  return isString(value) && DIGEST_RE.test(value);
}

/** Strict base64url: the alphabet only, no padding; `null` on anything else. */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length === 0 || !BASE64URL_RE.test(value)) return null;
  try {
    return b64urlToBytes(value);
  } catch {
    return null;
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return bytesToB64url(bytes);
}

/** ISO 8601 → epoch milliseconds, or `null` when the string is not a time. */
export function parseIsoTime(value: JsonValue | undefined): number | null {
  if (!isString(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

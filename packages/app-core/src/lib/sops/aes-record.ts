/**
 * SOPS AES-256-GCM value framing from getsops/sops `aes/cipher.go`
 * (26e2f478, v3.13.3): `ENC[AES256_GCM,data:…,iv:…,tag:…,type:…]` with
 * standard base64 fields, a 32-byte writer nonce, a 16-byte tag carried
 * separately, and the associated data passed through untouched.
 *
 * AES-GCM is `@noble/ciphers`, which accepts non-96-bit nonces the way Go's
 * `cipher.NewGCMWithNonceSize` does; no nonce is truncated or rehashed.
 * Parsing is stricter than upstream's unanchored regex: every field must be
 * canonical base64, the frame must end at `]`, and the type must be known.
 */

import { gcm } from "@noble/ciphers/aes";
import { SopsError } from "./errors.js";
import {
  GCM_TAG_BYTES,
  MAX_ENCRYPTED_FIELD_BYTES,
  MAX_NONCE_BYTES,
  MIN_NONCE_BYTES,
} from "./limits.js";
import {
  type SopsPlain,
  canonicalInt,
  goParseFloatText,
  plainToText,
} from "./scalars.js";
import { canonicalTimeText } from "./time.js";

const RECORD =
  /^ENC\[AES256_GCM,data:([A-Za-z0-9+/=]*),iv:([A-Za-z0-9+/=]+),tag:([A-Za-z0-9+/=]+),type:([a-z]+)\]$/u;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const TRUE_WORDS = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const FALSE_WORDS = new Set(["0", "f", "F", "FALSE", "false", "False"]);

const utf8 = new TextEncoder();

export function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function unb64(
  text: string,
  limit = MAX_ENCRYPTED_FIELD_BYTES,
): Uint8Array {
  if (text.length > (limit / 3) * 4 + 4 || !BASE64.test(text)) {
    throw new SopsError(
      "malformed_encoding",
      "A field is not canonical base64.",
    );
  }
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SopsError(
      "malformed_encoding",
      "A decrypted value is not UTF-8.",
    );
  }
}

/** Upstream `isEmpty`: empty strings and empty comments are never encrypted. */
export function isEmptyPlain(plain: SopsPlain): boolean {
  return (
    (plain.kind === "str" || plain.kind === "comment") && plain.value === ""
  );
}

export function isEncryptedRecord(value: string): boolean {
  return value.startsWith("ENC[AES256_GCM,");
}

function typeLabel(plain: SopsPlain): string {
  return plain.kind === "comment" ? "comment" : plain.kind;
}

/** Seal one leaf with a fresh 32-byte nonce under `key` and `aad`. */
export function encryptPlain(
  plain: SopsPlain,
  key: Uint8Array,
  aad: string,
): string {
  if (isEmptyPlain(plain)) return "";
  const iv = new Uint8Array(32);
  crypto.getRandomValues(iv);
  const sealed = gcm(key, iv, utf8.encode(aad)).encrypt(
    utf8.encode(plainToText(plain)),
  );
  if (sealed.byteLength < GCM_TAG_BYTES) {
    throw new SopsError("malformed_encoding", "AES-GCM output truncated.");
  }
  const data = sealed.subarray(0, sealed.byteLength - GCM_TAG_BYTES);
  const tag = sealed.subarray(sealed.byteLength - GCM_TAG_BYTES);
  return `ENC[AES256_GCM,data:${b64(data)},iv:${b64(iv)},tag:${b64(tag)},type:${typeLabel(plain)}]`;
}

export type ParsedRecord = {
  data: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  type: string;
};

/** Split a frame into validated fields without touching the key. */
export function parseRecord(record: string): ParsedRecord {
  const match = RECORD.exec(record);
  if (!match) {
    throw new SopsError(
      "malformed_encoding",
      "A value is not an AES256_GCM record.",
    );
  }
  const data = unb64(match[1] ?? "");
  const iv = unb64(match[2] ?? "", MAX_NONCE_BYTES);
  const tag = unb64(match[3] ?? "", GCM_TAG_BYTES);
  if (iv.byteLength < MIN_NONCE_BYTES || iv.byteLength > MAX_NONCE_BYTES) {
    throw new SopsError(
      "malformed_encoding",
      "A record nonce has an unsupported length.",
    );
  }
  if (tag.byteLength !== GCM_TAG_BYTES) {
    throw new SopsError("malformed_encoding", "A record tag is not 16 bytes.");
  }
  return { data, iv, tag, type: match[4] ?? "" };
}

function typedPlain(type: string, text: string, bytes: Uint8Array): SopsPlain {
  switch (type) {
    case "str":
      return { kind: "str", value: text };
    case "bytes":
      // Upstream converts []byte leaves to strings before walking them.
      return { kind: "str", value: decodeUtf8(bytes) };
    case "int": {
      if (!/^[+-]?\d+$/u.test(text)) {
        throw new SopsError(
          "malformed_encoding",
          "A decrypted int is not decimal.",
        );
      }
      const value = canonicalInt(BigInt(text));
      if (value === null) {
        throw new SopsError(
          "malformed_encoding",
          "A decrypted int is out of range.",
        );
      }
      return { kind: "int", value };
    }
    case "float": {
      const value = goParseFloatText(text);
      if (value === null) {
        throw new SopsError(
          "malformed_encoding",
          "A decrypted float is not numeric.",
        );
      }
      return { kind: "float", value };
    }
    case "bool":
      if (TRUE_WORDS.has(text)) return { kind: "bool", value: true };
      if (FALSE_WORDS.has(text)) return { kind: "bool", value: false };
      throw new SopsError(
        "malformed_encoding",
        "A decrypted bool is not a Go bool.",
      );
    case "time":
      return { kind: "time", value: canonicalTimeText(text) };
    case "comment":
      return { kind: "comment", value: text };
    default:
      throw new SopsError(
        "unsupported_feature",
        "A record type is unsupported.",
      );
  }
}

/** Open one frame; the empty string is the unencrypted empty value. */
export function decryptRecord(
  record: string,
  key: Uint8Array,
  aad: string,
): SopsPlain {
  if (record === "") return { kind: "str", value: "" };
  const parsed = parseRecord(record);
  const sealed = new Uint8Array(parsed.data.byteLength + parsed.tag.byteLength);
  sealed.set(parsed.data, 0);
  sealed.set(parsed.tag, parsed.data.byteLength);
  let bytes: Uint8Array;
  try {
    bytes = gcm(key, parsed.iv, utf8.encode(aad)).decrypt(sealed);
  } catch {
    throw new SopsError(
      "authentication_failed",
      "A value failed AES-GCM authentication.",
    );
  }
  const text = parsed.type === "bytes" ? "" : decodeUtf8(bytes);
  return typedPlain(parsed.type, text, bytes);
}

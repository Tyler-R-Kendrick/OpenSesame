/**
 * SOPS AES-256-GCM value framing from getsops/sops `aes/cipher.go`
 * (26e2f478, v3.13.3). Nonce is 32 bytes. Tag is 16 bytes.
 * AES-GCM itself is `@noble/ciphers`, which accepts that nonce length.
 */

import { gcm } from "@noble/ciphers/aes";

const RECORD =
  /^ENC\[AES256_GCM,data:([^,]*),iv:([^,]*),tag:([^,]*),type:([A-Za-z0-9_]+)\]$/u;

export type SopsScalar =
  | { kind: "str"; value: string }
  | { kind: "int"; value: string }
  | { kind: "float"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "comment"; value: string };

const MAX_FIELD = 8 * 1024 * 1024;

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unb64(text: string): Uint8Array {
  if (text.length > MAX_FIELD) throw new Error("sops field too large");
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Upstream `ToBytes` for MAC input. */
export function scalarToBytes(scalar: SopsScalar): Uint8Array {
  switch (scalar.kind) {
    case "str":
    case "comment":
      return utf8(scalar.value);
    case "int":
      return utf8(scalar.value);
    case "float":
      return utf8(scalar.value);
    case "bool":
      return utf8(scalar.value ? "True" : "False");
    default: {
      const unreachable: never = scalar;
      return unreachable;
    }
  }
}

function seal(
  key: Uint8Array,
  iv: Uint8Array,
  plain: Uint8Array,
  aad: string,
): Uint8Array {
  return gcm(key, iv, utf8(aad)).encrypt(plain);
}

function open(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
  tag: Uint8Array,
  aad: string,
): Uint8Array {
  const sealed = new Uint8Array(data.byteLength + tag.byteLength);
  sealed.set(data, 0);
  sealed.set(tag, data.byteLength);
  return gcm(key, iv, utf8(aad)).decrypt(sealed);
}

export function encryptScalar(
  scalar: SopsScalar,
  key: Uint8Array,
  aad: string,
): string {
  if (scalar.kind !== "bool" && scalar.value === "") return "";
  const iv = new Uint8Array(32);
  crypto.getRandomValues(iv);
  const plain =
    scalar.kind === "bool"
      ? utf8(scalar.value ? "True" : "False")
      : utf8(scalar.value);
  const sealed = seal(key, iv, plain, aad);
  if (sealed.byteLength < 16) throw new Error("sops seal truncated");
  const data = sealed.subarray(0, sealed.byteLength - 16);
  const tag = sealed.subarray(sealed.byteLength - 16);
  const type = scalar.kind === "comment" ? "comment" : scalar.kind;
  return `ENC[AES256_GCM,data:${b64(data)},iv:${b64(iv)},tag:${b64(tag)},type:${type}]`;
}

export function decryptRecord(
  record: string,
  key: Uint8Array,
  aad: string,
): SopsScalar {
  if (record === "") return { kind: "str", value: "" };
  const match = RECORD.exec(record);
  if (!match) throw new Error("sops value is not an AES256_GCM record");
  const data = unb64(match[1] ?? "");
  const iv = unb64(match[2] ?? "");
  const tag = unb64(match[3] ?? "");
  const datatype = match[4] ?? "";
  if (iv.byteLength < 8 || tag.byteLength !== 16) {
    throw new Error("sops record has a malformed nonce or tag");
  }
  const plain = text(open(key, iv, data, tag, aad));
  switch (datatype) {
    case "str":
      return { kind: "str", value: plain };
    case "int":
      if (!/^-?\d+$/u.test(plain)) throw new Error("sops int is not decimal");
      return { kind: "int", value: plain };
    case "float":
      return { kind: "float", value: plain };
    case "bool":
      if (plain !== "True" && plain !== "False") {
        throw new Error("sops bool is not True or False");
      }
      return { kind: "bool", value: plain === "True" };
    case "comment":
      return { kind: "comment", value: plain };
    default:
      throw new Error("sops record type is unsupported");
  }
}

export function isEncryptedRecord(value: string): boolean {
  return value.startsWith("ENC[AES256_GCM,");
}

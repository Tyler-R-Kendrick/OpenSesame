/**
 * Shared byte encoding and KDF helpers for profile slots and PRF-and-code envelopes.
 */

import {
  assertDuressCodeLength,
  assertDuressKdfParams,
} from "../keys/pin-floors.js";

export const te = new TextEncoder();
export const SLOT_PURPOSE = te.encode("opensesame/duress/slot/v1");
export const PRF_CODE_PURPOSE = te.encode("opensesame/duress/prf-and-code/v1");
export const IV_BYTES = 12;
export const SALT_BYTES = 16;

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importAes(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function pbkdf2(
  code: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  assertDuressKdfParams({ iterations, saltB64: b64(salt) });
  const base = await crypto.subtle.importKey(
    "raw",
    te.encode(code),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export function assertTriggerCodeLength(code: string): void {
  assertDuressCodeLength(code);
}

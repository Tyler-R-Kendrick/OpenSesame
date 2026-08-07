/**
 * TypeScript façade mirroring `crates/client-core` sync shapes.
 * Full AEAD runs in Rust; this package provides cursor/blob types + opaque push helpers for api-client.
 */

export interface SyncCursor {
  deviceId: string;
  epoch: number;
}

export interface SyncBlob {
  id: string;
  epoch: number;
  /** Base64 ciphertext — never plaintext */
  ciphertextB64: string;
}

export function createCursor(deviceId: string): SyncCursor {
  return { deviceId, epoch: 0 };
}

/** Encode UTF-8 bytes to base64 (browser + node). */
export function bytesToB64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Dev-only seal: XOR with repeating key — NOT for production.
 * Production must call Rust client-core / wasm. Marked clearly.
 */
export function sealDevOnly(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    out[i] = plaintext[i]! ^ key[i % key.length]!;
  }
  return out;
}

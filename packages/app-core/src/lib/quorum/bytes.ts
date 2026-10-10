/** Byte helpers for the quorum modules. Nothing here holds a secret. */

const utf8 = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return utf8.encode(text);
}

export function utf8Text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** base64url without padding, the encoding WebAuthn and every packet use. */
export function toB64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

const B64URL = /^[A-Za-z0-9_-]*$/;

export function fromB64url(text: string): Uint8Array {
  if (!B64URL.test(text) || text.length % 4 === 1) {
    throw new Error("not base64url");
  }
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Equal length and equal bytes, without stopping at the first difference. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

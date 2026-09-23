/**
 * Standard base64 (RFC 4648 §4, padded) over bytes — the one implementation
 * the vault format, the app core and its adapters share. Uses the runtime
 * contract's `btoa`/`atob`, which an isolate gets from the sandbox contract.
 */

export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Base64url without padding (RFC 4648 §5), as drop-link fragments carry it. */
export function bytesToB64url(bytes: Uint8Array): string {
  return bytesToB64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Base64url, padded or not; throws on anything else. */
export function b64urlToBytes(value: string): Uint8Array {
  return b64ToBytes(value.replaceAll("-", "+").replaceAll("_", "/"));
}

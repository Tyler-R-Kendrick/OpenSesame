const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function isBase64url(value: string): boolean {
  return BASE64URL.test(value);
}

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeBase64url(value: string): Uint8Array {
  if (!BASE64URL.test(value)) {
    throw new SyntaxError("not base64url");
  }
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.length === 0 || value.length % 4 === 1) {
    throw new SyntaxError("not base64url");
  }
  return bytes;
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function constantTimeEquals(left: string, right: string): boolean {
  const a = encodeUtf8(left);
  const b = encodeUtf8(right);
  const len = Math.max(a.length, b.length, 1);
  const padA = new Uint8Array(len);
  const padB = new Uint8Array(len);
  padA.set(a);
  padB.set(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    const leftByte = padA[i];
    const rightByte = padB[i];
    if (leftByte === undefined || rightByte === undefined) {
      diff |= 1;
      continue;
    }
    diff |= leftByte ^ rightByte;
  }
  return diff === 0;
}

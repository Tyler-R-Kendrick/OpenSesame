/**
 * Standard base64 (RFC 4648 §4, padded) over bytes — the one implementation
 * the vault format, the app core and its adapters share. Encoding is table
 * driven; decoding uses the runtime contract's `atob`, which an isolate gets
 * from the sandbox contract.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// Every 12-bit group as its two characters, so each 3-byte group costs two
// lookups. A byte at a time through `btoa` built a string as long as the input
// first, which every sealed write paid for.
const PAIRS: string[] = Array.from(
  { length: 4096 },
  (_, i) => `${ALPHABET[i >> 6]}${ALPHABET[i & 63]}`,
);
/** Output strings are assembled in pieces of this many characters. */
const PIECE = 8192;

export function bytesToB64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  let piece = "";
  const whole = bytes.length - (bytes.length % 3);
  for (let i = 0; i < whole; i += 3) {
    const group =
      ((bytes[i] ?? 0) << 16) |
      ((bytes[i + 1] ?? 0) << 8) |
      (bytes[i + 2] ?? 0);
    piece += (PAIRS[group >> 12] ?? "") + (PAIRS[group & 4095] ?? "");
    if (piece.length >= PIECE) {
      pieces.push(piece);
      piece = "";
    }
  }
  const rest = bytes.length - whole;
  if (rest === 1) {
    const group = (bytes[whole] ?? 0) << 16;
    piece += `${PAIRS[group >> 12]}==`;
  } else if (rest === 2) {
    const group = ((bytes[whole] ?? 0) << 16) | ((bytes[whole + 1] ?? 0) << 8);
    piece += `${PAIRS[group >> 12]}${ALPHABET[(group >> 6) & 63]}=`;
  }
  pieces.push(piece);
  return pieces.join("");
}

/** Each character code's 6-bit value; -1 for anything outside the alphabet. */
const VALUE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i += 1) VALUE[ALPHABET.charCodeAt(i)] = i;

function valueAt(b64: string, i: number): number {
  const code = b64.charCodeAt(i);
  return code < 128 ? (VALUE[code] ?? -1) : -1;
}

/**
 * Strict standard base64: whole quartets, padding only at the end. Anything
 * else is refused with the same `InvalidCharacterError` `atob` raises, which
 * is what this replaced; the fast path covers what every seal writes.
 */
export function b64ToBytes(b64: string): Uint8Array {
  if (b64.length % 4 !== 0) return fromAtob(b64);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((b64.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < b64.length; i += 4) {
    const last = i + 4 === b64.length;
    const a = valueAt(b64, i);
    const b = valueAt(b64, i + 1);
    const c = last && pad === 2 ? 0 : valueAt(b64, i + 2);
    const d = last && pad >= 1 ? 0 : valueAt(b64, i + 3);
    if ((a | b | c | d) < 0) return fromAtob(b64);
    const group = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = group >> 16;
    if (o < out.length) out[o++] = (group >> 8) & 255;
    if (o < out.length) out[o++] = group & 255;
  }
  return out;
}

/** Whatever the fast path does not take: `atob`'s own rules, and its errors. */
function fromAtob(b64: string): Uint8Array {
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

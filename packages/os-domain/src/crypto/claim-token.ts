import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Purpose prefixes keep digests domain-separated. */
export const CLAIM_TOKEN_PURPOSE = "opensesame:claim-token:v1";
export const USER_CODE_PURPOSE = "opensesame:user-code:v1";
export const DEVICE_CODE_PURPOSE = "opensesame:device-code:v1";

const CLAIM_TOKEN_PREFIX = "osc_clm_";

export interface GeneratedClaimToken {
  /** Full bearer: osc_clm_<publicId>.<secret> */
  token: string;
  publicId: string;
  secret: string;
  digest: Uint8Array;
}

function encodeBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * HMAC-SHA-256(pepper, purpose || publicId || secret) with length prefixes
 * to avoid ambiguity across field boundaries.
 */
export function hmacDigest(
  pepper: Uint8Array | string,
  purpose: string,
  publicId: string,
  secret: string,
): Uint8Array {
  const key =
    typeof pepper === "string" ? Buffer.from(pepper, "utf8") : Buffer.from(pepper);
  const h = createHmac("sha256", key);
  const writeLenPrefixed = (s: string) => {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    h.update(len);
    h.update(b);
  };
  writeLenPrefixed(purpose);
  writeLenPrefixed(publicId);
  writeLenPrefixed(secret);
  return new Uint8Array(h.digest());
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    const dummy = Buffer.alloc(Math.max(a.length, 1));
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function generateClaimToken(
  pepper: Uint8Array | string,
  publicId: string = encodeBase64Url(randomBytes(16)),
  secretBytes: Buffer = randomBytes(32),
): GeneratedClaimToken {
  const secret = encodeBase64Url(secretBytes);
  const token = `${CLAIM_TOKEN_PREFIX}${publicId}.${secret}`;
  const digest = hmacDigest(pepper, CLAIM_TOKEN_PURPOSE, publicId, secret);
  return { token, publicId, secret, digest };
}

export function parseClaimToken(
  token: string,
): { publicId: string; secret: string } | null {
  if (!token.startsWith(CLAIM_TOKEN_PREFIX)) {
    return null;
  }
  const rest = token.slice(CLAIM_TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) {
    return null;
  }
  const publicId = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!publicId || !secret) {
    return null;
  }
  return { publicId, secret };
}

export function digestClaimToken(
  pepper: Uint8Array | string,
  token: string,
): Uint8Array | null {
  const parsed = parseClaimToken(token);
  if (!parsed) {
    return null;
  }
  return hmacDigest(pepper, CLAIM_TOKEN_PURPOSE, parsed.publicId, parsed.secret);
}

export function verifyClaimToken(
  pepper: Uint8Array | string,
  token: string,
  expectedDigest: Uint8Array,
): boolean {
  const digest = digestClaimToken(pepper, token);
  if (!digest) {
    return false;
  }
  return constantTimeEqual(digest, expectedDigest);
}

/** Crockford Base32 alphabet (no I, L, O, U). */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Safer Crockford normalize: O→0, I/L→1, strip separators. */
export function normalizeUserCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s\-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function digestUserCode(
  pepper: Uint8Array | string,
  code: string,
): Uint8Array {
  const normalized = normalizeUserCode(code);
  return hmacDigest(pepper, USER_CODE_PURPOSE, "user-code", normalized);
}

export function digestDeviceCode(
  pepper: Uint8Array | string,
  code: string,
): Uint8Array {
  return hmacDigest(pepper, DEVICE_CODE_PURPOSE, "device-code", code);
}

export function generateUserCode(byteCount = 5): string {
  // 5 bytes ≈ 40 bits entropy
  const bytes = randomBytes(byteCount);
  let bits = 0n;
  for (const b of bytes) {
    bits = (bits << 8n) | BigInt(b);
  }
  const chars: string[] = [];
  const totalChars = Math.ceil((byteCount * 8) / 5);
  for (let i = 0; i < totalChars; i++) {
    const idx = Number(bits & 0x1fn);
    chars.push(CROCKFORD_ALPHABET[idx]!);
    bits >>= 5n;
  }
  const raw = chars.join("");
  if (raw.length >= 8) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  }
  return raw;
}

export function verifyUserCode(
  pepper: Uint8Array | string,
  code: string,
  expectedDigest: Uint8Array,
): boolean {
  const digest = digestUserCode(pepper, code);
  return constantTimeEqual(digest, expectedDigest);
}

/**
 * The return code: the one secret that opens a travel bundle (ADR 0140).
 *
 * 18 random bytes and a 2-byte check, written as 32 base32 characters in
 * groups of four. It is shown once, at departure, and never stored on this
 * device — the traveller leaves it at home or with someone they trust, which
 * is what makes "I cannot open it from here" a true statement at a border.
 * The check catches a mistyped code before it is mistaken for a wrong one.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_BYTES = 18;
const CHECK_BYTES = 2;
const CODE_CHARS = 32;
const HKDF_INFO = "opensesame.travel-bundle.v1";

export type ReturnSecret = Readonly<{ bytes: Uint8Array }>;

export class ReturnCodeError extends Error {
  readonly code: "code_malformed";

  constructor(message: string) {
    super(message);
    this.name = "ReturnCodeError";
    this.code = "code_malformed";
  }
}

async function checkBytes(secret: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(secret));
  return new Uint8Array(digest).slice(0, CHECK_BYTES);
}

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function decodeBase32(text: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) {
      throw new ReturnCodeError(`"${char}" is not part of a return code.`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Uppercase, drop separators, and read the digits people confuse as letters. */
function normalize(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/8/g, "B");
}

export function mintReturnSecret(): ReturnSecret {
  return { bytes: crypto.getRandomValues(new Uint8Array(SECRET_BYTES)) };
}

/** `ABCD-EFGH-…`, eight groups of four. */
export async function formatReturnCode(secret: ReturnSecret): Promise<string> {
  const joined = new Uint8Array(SECRET_BYTES + CHECK_BYTES);
  joined.set(secret.bytes);
  joined.set(await checkBytes(secret.bytes), SECRET_BYTES);
  const text = encodeBase32(joined);
  return text.match(/.{1,4}/g)?.join("-") ?? text;
}

/** Read a typed code back into its secret, or refuse a malformed one. */
export async function parseReturnCode(code: string): Promise<ReturnSecret> {
  const clean = normalize(code);
  if (clean.length !== CODE_CHARS) {
    throw new ReturnCodeError(
      `A return code is ${CODE_CHARS} characters; this one has ${clean.length}.`,
    );
  }
  const joined = decodeBase32(clean);
  const bytes = joined.slice(0, SECRET_BYTES);
  const check = await checkBytes(bytes);
  if (
    joined.length !== SECRET_BYTES + CHECK_BYTES ||
    check.some((byte, i) => byte !== joined[SECRET_BYTES + i])
  ) {
    throw new ReturnCodeError("That return code has a typo in it.");
  }
  return { bytes };
}

/**
 * The bundle key: HKDF-SHA-256 over the secret, salted with the bundle id,
 * so one code opens one bundle and nothing else.
 */
export async function deriveBundleKey(
  secret: ReturnSecret,
  bundleId: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret.bytes),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(bundleId),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

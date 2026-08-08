/** RFC 6238 TOTP over WebCrypto HMAC. Accepts a bare base32 seed or an otpauth:// URI. */

export type TotpConfig = {
  secret: Uint8Array;
  digits: number;
  period: number;
  algorithm: "SHA-1" | "SHA-256" | "SHA-512";
};

export class TotpParseError extends Error {
  constructor(detail: string) {
    super(`This is not a usable authenticator secret: ${detail}`);
    this.name = "TotpParseError";
  }
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function decodeBase32(input: string): Uint8Array {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean) throw new TotpParseError("the secret is empty");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new TotpParseError(`unexpected character "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  if (out.length === 0) throw new TotpParseError("the secret decodes to no bytes");
  return new Uint8Array(out);
}

function normalizeAlgorithm(raw: string | null): TotpConfig["algorithm"] {
  switch ((raw ?? "SHA1").toUpperCase()) {
    case "SHA1":
    case "SHA-1":
      return "SHA-1";
    case "SHA256":
    case "SHA-256":
      return "SHA-256";
    case "SHA512":
    case "SHA-512":
      return "SHA-512";
    default:
      throw new TotpParseError("unsupported hash algorithm");
  }
}

export function parseTotp(raw: string): TotpConfig {
  const trimmed = raw.trim();
  if (!trimmed) throw new TotpParseError("the secret is empty");

  if (/^otpauth:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new TotpParseError("the otpauth URI is malformed");
    }
    const secret = url.searchParams.get("secret");
    if (!secret) throw new TotpParseError("the otpauth URI has no secret parameter");
    const digits = Number(url.searchParams.get("digits") ?? 6);
    const period = Number(url.searchParams.get("period") ?? 30);
    return {
      secret: decodeBase32(secret),
      digits: Number.isFinite(digits) && digits >= 6 && digits <= 10 ? digits : 6,
      period: Number.isFinite(period) && period > 0 ? period : 30,
      algorithm: normalizeAlgorithm(url.searchParams.get("algorithm")),
    };
  }

  return {
    secret: decodeBase32(trimmed),
    digits: 6,
    period: 30,
    algorithm: "SHA-1",
  };
}

export async function totpCode(
  config: TotpConfig,
  atMs: number = Date.now(),
): Promise<string> {
  const counter = Math.floor(atMs / 1000 / config.period);
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    "raw",
    config.secret as BufferSource,
    { name: "HMAC", hash: config.algorithm },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** config.digits).padStart(config.digits, "0");
}

export function secondsRemaining(
  period: number,
  atMs: number = Date.now(),
): number {
  return period - (Math.floor(atMs / 1000) % period);
}

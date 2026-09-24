import { overlapCast } from "@opensesame/os-domain";
/** RFC 6238 TOTP over WebCrypto HMAC. Accepts a bare base32 seed or an otpauth:// URI. */

export type TotpConfig = {
  secret: Uint8Array;
  digits: number;
  period: number;
  algorithm: "SHA-1" | "SHA-256" | "SHA-512";
};

export type HotpConfig = Omit<TotpConfig, "period"> & {
  counter: number;
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
    if (index === -1)
      throw new TotpParseError(`unexpected character "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  if (out.length === 0)
    throw new TotpParseError("the secret decodes to no bytes");
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

/**
 * A decimal parameter in `[min, max]`, or the default when absent. An invalid
 * value is refused, never replaced: a code computed from other parameters than
 * the issuer's is wrong (spec/conformance/otp-cases.json).
 */
function integerParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
  what: string,
): number {
  if (value === null) return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new TotpParseError(`the ${what} is invalid`);
  }
  return n;
}

type OtpauthUri = {
  params: (name: string) => string | null;
  secret: Uint8Array;
  digits: number;
  algorithm: TotpConfig["algorithm"];
};

function parseOtpauth(raw: string, kind: "totp" | "hotp"): OtpauthUri {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TotpParseError("the otpauth URI is malformed");
  }
  if (url.protocol !== "otpauth:" || url.hostname.toLowerCase() !== kind) {
    throw new TotpParseError(`the URI is not ${kind.toUpperCase()}`);
  }
  if (url.username || url.password || url.hash) {
    throw new TotpParseError("credentials and fragments are forbidden");
  }
  const params = (name: string): string | null => {
    const values = url.searchParams.getAll(name);
    if (values.length > 1) throw new TotpParseError(`repeated ${name}`);
    return values[0] ?? null;
  };
  const secret = params("secret");
  if (!secret)
    throw new TotpParseError("the otpauth URI has no secret parameter");
  return {
    params,
    secret: decodeBase32(secret),
    digits: integerParam(params("digits"), 6, 6, 10, "digit count"),
    algorithm: normalizeAlgorithm(params("algorithm")),
  };
}

function parseTotpDefault(raw: string): TotpConfig {
  const trimmed = raw.trim();
  if (!trimmed) throw new TotpParseError("the secret is empty");

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    const uri = parseOtpauth(trimmed, "totp");
    return {
      secret: uri.secret,
      digits: uri.digits,
      period: integerParam(
        uri.params("period"),
        30,
        1,
        Number.MAX_SAFE_INTEGER,
        "period",
      ),
      algorithm: uri.algorithm,
    };
  }

  return {
    secret: decodeBase32(trimmed),
    digits: 6,
    period: 30,
    algorithm: "SHA-1",
  };
}

async function totpCodeDefault(
  config: TotpConfig,
  atMs: number = Date.now(),
): Promise<string> {
  const counter = Math.floor(atMs / 1000 / config.period);
  return hmacOtpCode(config, counter);
}

async function hmacOtpCode(
  config: Pick<TotpConfig, "secret" | "digits" | "algorithm">,
  counter: number,
): Promise<string> {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    "raw",
    overlapCast(config.secret),
    { name: "HMAC", hash: config.algorithm },
    false,
    ["sign"],
  );
  const mac = new DataView(await crypto.subtle.sign("HMAC", key, buffer));
  // RFC 4226 dynamic truncation: the low nibble of the last byte picks the
  // four-byte window, whose high bit is masked off.
  const offset = mac.getUint8(mac.byteLength - 1) & 0x0f;
  const binary = mac.getUint32(offset) & 0x7fff_ffff;
  return String(binary % 10 ** config.digits).padStart(config.digits, "0");
}

/** Parse a counter-based RFC 4226 otpauth URI. */
export function parseHotp(raw: string): HotpConfig {
  const uri = parseOtpauth(raw, "hotp");
  const counterRaw = uri.params("counter");
  if (counterRaw === null)
    throw new TotpParseError("the HOTP counter is missing or invalid");
  return {
    secret: uri.secret,
    digits: uri.digits,
    counter: integerParam(
      counterRaw,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
      "HOTP counter",
    ),
    algorithm: uri.algorithm,
  };
}

/** Generate RFC 4226 HOTP for an explicit counter. Persist the increment first. */
export function hotpCode(
  config: HotpConfig,
  counter = config.counter,
): Promise<string> {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    return Promise.reject(new TotpParseError("the HOTP counter is invalid"));
  }
  return hmacOtpCode(config, counter);
}

function secondsRemainingDefault(
  period: number,
  atMs: number = Date.now(),
): number {
  return period - (Math.floor(atMs / 1000) % period);
}

export const totpSeams = {
  parseTotp: parseTotpDefault,
  totpCode: totpCodeDefault,
  secondsRemaining: secondsRemainingDefault,
};

export function parseTotp(raw: string): TotpConfig {
  return totpSeams.parseTotp(raw);
}

export async function totpCode(
  config: TotpConfig,
  atMs: number = Date.now(),
): Promise<string> {
  return totpSeams.totpCode(config, atMs);
}

export function secondsRemaining(
  period: number,
  atMs: number = Date.now(),
): number {
  return totpSeams.secondsRemaining(period, atMs);
}

export type TotpSetupOptions = { label?: string; issuer?: string };

/**
 * Build an otpauth:// URI suitable for authenticator QR enrollment.
 * Passes through an existing otpauth URI after validating it.
 */
export function totpSetupUri(raw: string, opts: TotpSetupOptions = {}): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new TotpParseError("the secret is empty");
  if (/^otpauth:\/\//i.test(trimmed)) {
    parseTotp(trimmed);
    return trimmed;
  }
  const config = parseTotp(trimmed);
  const secret = trimmed.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  const label = encodeURIComponent(opts.label ?? "OpenSesame");
  const params = new URLSearchParams({
    secret,
    digits: String(config.digits),
    period: String(config.period),
    algorithm: config.algorithm.replace("-", ""),
  });
  if (opts.issuer) params.set("issuer", opts.issuer);
  return `otpauth://totp/${label}?${params.toString()}`;
}

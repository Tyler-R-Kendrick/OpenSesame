/**
 * Additional vault unlock methods beyond the master password.
 *
 * Password wrap stays the classic path (VaultHeader.wrap). Passkey (WebAuthn PRF)
 * and PIN each store an alternate AES-GCM wrap of the same vault key. Optional
 * TOTP is a second factor after any primary unwrap — the TOTP seed is sealed
 * under the vault key so it is only readable after primary unlock succeeds.
 */

import {
  type KdfParams,
  MAX_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  type SealedBlob,
  VaultCorruptError,
  type VaultHeader,
  WrongPasswordError,
  assertKdfParams,
  b64ToBytes,
  bytesToB64,
  randomBytes,
} from "./crypto.js";
import { parseTotp, totpCode } from "./totp.js";

const IV_BYTES = 12;
const PRF_INFO = new TextEncoder().encode("opensesame/vault/webauthn-prf/v1");

export const MIN_PIN_LENGTH = 8;
export const MAX_PIN_LENGTH = 12;
/** PIN wraps use at least the password floor; extra iterations raise offline cost. */
export const PIN_PBKDF2_ITERATIONS = 1_200_000;

export type PasskeyUnlockRecord = {
  credentialIdB64: string;
  userIdB64: string;
  /** Public salt fed to the PRF eval + HKDF. */
  prfSaltB64: string;
  wrap: SealedBlob;
};

export type PinUnlockRecord = {
  kdf: KdfParams;
  wrap: SealedBlob;
};

export type TotpGateRecord = {
  /** AES-GCM(VK) over the TOTP secret (UTF-8 / base32 seed). */
  secretWrap: SealedBlob;
  digits: 6;
  period: 30;
};

export type VaultUnlocks = {
  passkey?: PasskeyUnlockRecord;
  pin?: PinUnlockRecord;
  totp?: TotpGateRecord;
};

export type UnlockMethodId = "password" | "passkey" | "pin";

export function listAvailableUnlockMethods(
  header: VaultHeader | null | undefined,
): UnlockMethodId[] {
  if (!header) return [];
  const methods: UnlockMethodId[] = [];
  if (header.unlocks?.passkey) methods.push("passkey");
  if (header.unlocks?.pin) methods.push("pin");
  if (header.wrap && header.kdf) methods.push("password");
  return methods;
}

export function preferredUnlockMethod(
  header: VaultHeader | null | undefined,
): UnlockMethodId | null {
  const methods = listAvailableUnlockMethods(header);
  if (methods.includes("passkey")) return "passkey";
  if (methods.includes("pin")) return "pin";
  if (methods.includes("password")) return "password";
  return null;
}

export function assertPinPolicy(pin: string): void {
  const normalized = pin.normalize("NFKC");
  if (
    normalized.length < MIN_PIN_LENGTH ||
    normalized.length > MAX_PIN_LENGTH
  ) {
    throw new Error(
      `PIN must be ${MIN_PIN_LENGTH}–${MAX_PIN_LENGTH} characters.`,
    );
  }
  if (/\s/.test(normalized)) {
    throw new Error("PIN cannot contain spaces.");
  }
  if (/^(.)\1+$/u.test(normalized)) {
    throw new Error("PIN cannot be a repeated character.");
  }
  if (
    "01234567890123456789".includes(normalized) ||
    "98765432109876543210".includes(normalized)
  ) {
    throw new Error("PIN cannot be a sequential run of digits.");
  }
}

async function encryptWithKey(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<SealedBlob> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { ivB64: bytesToB64(iv), ctB64: bytesToB64(new Uint8Array(ct)) };
}

async function decryptWithKey(
  key: CryptoKey,
  blob: SealedBlob,
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(blob.ivB64) as BufferSource },
    key,
    b64ToBytes(blob.ctB64) as BufferSource,
  );
  return new Uint8Array(plain);
}

async function deriveAesKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** HKDF-SHA-256 matching crates/human-vault kek_from_webauthn_prf. */
export async function kekFromWebauthnPrf(
  prfOutput: ArrayBuffer,
  publicSalt: Uint8Array,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: publicSalt as BufferSource,
      info: PRF_INFO,
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function exportRawVaultKey(
  vaultKey: CryptoKey,
): Promise<Uint8Array> {
  if (!vaultKey.extractable) {
    throw new Error("vault key is not extractable");
  }
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", vaultKey));
  return raw;
}

export async function wrapVaultKeyWithPin(
  rawVaultKey: Uint8Array,
  pin: string,
): Promise<PinUnlockRecord> {
  assertPinPolicy(pin);
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveAesKeyFromPassword(pin, salt, PIN_PBKDF2_ITERATIONS);
  const wrap = await encryptWithKey(kek, rawVaultKey);
  return {
    kdf: {
      alg: "PBKDF2-SHA256",
      saltB64: bytesToB64(salt),
      iterations: PIN_PBKDF2_ITERATIONS,
    },
    wrap,
  };
}

export async function unwrapVaultKeyWithPin(
  record: PinUnlockRecord,
  pin: string,
): Promise<Uint8Array> {
  assertPinPolicy(pin);
  if (record.kdf.alg !== "PBKDF2-SHA256") {
    throw new VaultCorruptError("unsupported PIN unlock format");
  }
  assertKdfParams(record.kdf);
  const kek = await deriveAesKeyFromPassword(
    pin,
    b64ToBytes(record.kdf.saltB64),
    record.kdf.iterations,
  );
  try {
    return await decryptWithKey(kek, record.wrap);
  } catch {
    throw new WrongPasswordError();
  }
}

export async function wrapVaultKeyWithPrf(
  rawVaultKey: Uint8Array,
  prfOutput: ArrayBuffer,
  prfSalt: Uint8Array,
  credentialId: ArrayBuffer,
  userId: ArrayBuffer,
): Promise<PasskeyUnlockRecord> {
  const kek = await kekFromWebauthnPrf(prfOutput, prfSalt);
  const wrap = await encryptWithKey(kek, rawVaultKey);
  return {
    credentialIdB64: bytesToB64(new Uint8Array(credentialId)),
    userIdB64: bytesToB64(new Uint8Array(userId)),
    prfSaltB64: bytesToB64(prfSalt),
    wrap,
  };
}

export async function unwrapVaultKeyWithPrf(
  record: PasskeyUnlockRecord,
  prfOutput: ArrayBuffer,
): Promise<Uint8Array> {
  const kek = await kekFromWebauthnPrf(
    prfOutput,
    b64ToBytes(record.prfSaltB64),
  );
  try {
    return await decryptWithKey(kek, record.wrap);
  } catch {
    throw new WrongPasswordError();
  }
}

export function prfExtensionSupported(
  results: AuthenticationExtensionsClientOutputs | undefined,
): boolean {
  const prf = results?.prf as
    | { enabled?: boolean; results?: { first?: ArrayBuffer } }
    | undefined;
  return Boolean(prf?.results?.first || prf?.enabled);
}

export function readPrfFirst(
  results: AuthenticationExtensionsClientOutputs | undefined,
): ArrayBuffer | null {
  const prf = results?.prf as { results?: { first?: ArrayBuffer } } | undefined;
  return prf?.results?.first ?? null;
}

export type PasskeyCeremony = {
  credential: PublicKeyCredential;
  prfOutput: ArrayBuffer;
  prfSalt: Uint8Array;
  userId: Uint8Array;
};

/** True when `hostname` is a bare IPv4/IPv6 literal (not a DNS name). */
export function isIpHostname(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 (including compressed forms) — any colon means not a DNS label for us.
  return host.includes(":");
}

export type WebauthnHostCheck = {
  ok: boolean;
  hostname: string;
  /** Suggested same-path URL on a WebAuthn-compatible host, when we can offer one. */
  fixUrl: string | null;
  /** Short operator-facing diagnosis. */
  reason: string;
};

/**
 * WebAuthn RP IDs must be DNS names. Chrome rejects `127.0.0.1` (and other IPs)
 * with `SecurityError: This is an invalid domain.` before any authenticator prompt.
 */
export function checkWebauthnHost(
  hostname?: string,
  href?: string,
): WebauthnHostCheck {
  const resolvedHref =
    href ??
    (typeof window === "undefined"
      ? "http://localhost/"
      : window.location.href);
  let host =
    hostname?.trim() ||
    (typeof window !== "undefined" ? window.location.hostname : "");
  if (!host) {
    try {
      host = new URL(resolvedHref).hostname;
    } catch {
      host = "localhost";
    }
  }
  if (!isIpHostname(host)) {
    return {
      ok: true,
      hostname: host,
      fixUrl: null,
      reason: "Origin uses a DNS hostname suitable for WebAuthn.",
    };
  }
  let fixUrl: string | null = null;
  try {
    const url = new URL(resolvedHref);
    if (host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
      url.hostname = "localhost";
      fixUrl = url.toString();
    }
  } catch {
    /* ignore */
  }
  return {
    ok: false,
    hostname: host,
    fixUrl,
    reason:
      host === "127.0.0.1" || host === "::1"
        ? "This tab is on a loopback IP. Browsers reject passkeys on IP origins — use localhost instead."
        : `This tab is on IP ${host}. Passkeys require a DNS hostname (not a raw IP).`,
  };
}

/** Relying-party id for WebAuthn on this origin. */
export function webauthnRpId(
  hostname: string = typeof window === "undefined"
    ? "localhost"
    : window.location.hostname,
): string {
  const host = hostname.trim() || "localhost";
  // Never hand the browser an IP RP ID — preflight should have redirected first.
  if (isIpHostname(host)) return "localhost";
  return host;
}

export class WebauthnHostError extends Error {
  readonly check: WebauthnHostCheck;
  constructor(check: WebauthnHostCheck) {
    super(formatWebauthnHostError(check));
    this.name = "WebauthnHostError";
    this.check = check;
  }
}

export function formatWebauthnHostError(check: WebauthnHostCheck): string {
  if (check.fixUrl) {
    return `${check.reason} Open ${check.fixUrl} (same vault), then enroll again.`;
  }
  return `${check.reason} Open this app via a hostname (for example a Tailscale MagicDNS name or localhost), then enroll again.`;
}

/** Map browser WebAuthn failures into actionable copy. */
export function describeWebauthnError(error: unknown): string {
  if (error instanceof WebauthnHostError) return error.message;
  if (!(error instanceof Error)) return "Passkey ceremony failed.";
  const name = error.name;
  const message = error.message.trim();
  if (
    name === "SecurityError" ||
    /invalid domain/i.test(message) ||
    /is an invalid domain/i.test(message)
  ) {
    const check = checkWebauthnHost();
    if (!check.ok) return formatWebauthnHostError(check);
    return "The browser rejected this origin for passkeys. Use a DNS hostname (localhost for local dev), not a raw IP address.";
  }
  if (name === "NotAllowedError") {
    return "Passkey was cancelled or timed out. Try again, or use a PIN / password unlock instead.";
  }
  if (name === "InvalidStateError") {
    return "A passkey for this site may already exist on this authenticator. Remove it from the OS password manager, or enroll on another device.";
  }
  if (name === "NotSupportedError") {
    return "This browser or authenticator does not support the passkey features OpenSesame needs (WebAuthn PRF). Use Chrome/Edge on a supported OS, or enroll a PIN / password instead.";
  }
  return message || "Passkey ceremony failed.";
}

export function assertWebauthnHost(): WebauthnHostCheck {
  const check = checkWebauthnHost();
  if (!check.ok) throw new WebauthnHostError(check);
  return check;
}

/** Prefer localhost for loopback IPs so WebAuthn can run. */
export function localhostEquivalentHref(href?: string): string | null {
  return checkWebauthnHost(undefined, href).fixUrl;
}

export function primaryUnlockCount(
  header: VaultHeader | null | undefined,
): number {
  return listAvailableUnlockMethods(header).length;
}

export function assertKeepsPrimaryUnlock(
  header: VaultHeader,
  removing: UnlockMethodId,
): void {
  const remaining = listAvailableUnlockMethods(header).filter(
    (method) => method !== removing,
  );
  if (remaining.length === 0) {
    throw new Error(
      "Keep at least one primary unlock method (passkey, PIN, or password).",
    );
  }
}

export async function createPasskeyUnlockCeremony(
  rpId: string = webauthnRpId(),
): Promise<PasskeyCeremony> {
  if (typeof PublicKeyCredential === "undefined") {
    throw new Error("This browser cannot create a passkey.");
  }
  assertWebauthnHost();
  const prfSalt = randomBytes(SALT_BYTES);
  const userId = randomBytes(16);
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        rp: { id: rpId, name: "OpenSesame" },
        user: {
          id: userId as BufferSource,
          name: "vault-unlock",
          displayName: "OpenSesame vault unlock",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "preferred",
          requireResidentKey: false,
          userVerification: "required",
        },
        timeout: 120_000,
        extensions: {
          prf: { eval: { first: prfSalt } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw new Error(describeWebauthnError(error));
  }
  if (!credential) throw new Error("Passkey creation was cancelled.");
  const prfOutput = readPrfFirst(credential.getClientExtensionResults());
  if (!prfOutput) {
    throw new Error(
      "This authenticator did not return a WebAuthn PRF result. Use a platform passkey that supports PRF, or unlock with a PIN / password.",
    );
  }
  return { credential, prfOutput, prfSalt, userId };
}

export async function getPasskeyUnlockCeremony(
  record: PasskeyUnlockRecord,
  rpId: string = webauthnRpId(),
): Promise<ArrayBuffer> {
  if (typeof PublicKeyCredential === "undefined") {
    throw new Error("This browser cannot use a passkey.");
  }
  assertWebauthnHost();
  const prfSalt = b64ToBytes(record.prfSaltB64);
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        rpId,
        allowCredentials: [
          {
            type: "public-key",
            id: b64ToBytes(record.credentialIdB64) as BufferSource,
          },
        ],
        userVerification: "required",
        timeout: 120_000,
        extensions: {
          prf: { eval: { first: prfSalt } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw new Error(describeWebauthnError(error));
  }
  if (!credential) throw new Error("Passkey unlock was cancelled.");
  const prfOutput = readPrfFirst(credential.getClientExtensionResults());
  if (!prfOutput) {
    throw new Error(
      "This authenticator did not return a WebAuthn PRF result for unlock.",
    );
  }
  return prfOutput;
}

export async function sealTotpSecret(
  vaultKey: CryptoKey,
  secret: string,
): Promise<TotpGateRecord> {
  const wrap = await encryptWithKey(
    vaultKey,
    new TextEncoder().encode(secret.normalize("NFKC")),
  );
  return { secretWrap: wrap, digits: 6, period: 30 };
}

export async function openTotpSecret(
  vaultKey: CryptoKey,
  record: TotpGateRecord,
): Promise<string> {
  const bytes = await decryptWithKey(vaultKey, record.secretWrap);
  return new TextDecoder().decode(bytes);
}

/** Random base32 secret for vault MFA enrollment (160-bit). */
export function randomTotpSecret(): string {
  const bytes = randomBytes(20);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** Accept current window ±1 period for clock skew. */
export async function totpCodeMatches(
  secret: string,
  code: string,
  digits = 6,
  period = 30,
): Promise<boolean> {
  const config = parseTotp(secret);
  const trimmed = code.replace(/\s/g, "");
  if (!/^\d+$/.test(trimmed) || trimmed.length !== digits) return false;
  const now = Date.now();
  for (const offset of [-1, 0, 1]) {
    const at = now + offset * period * 1000;
    if ((await totpCode({ ...config, digits, period }, at)) === trimmed) {
      return true;
    }
  }
  return false;
}

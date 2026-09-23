import { isString, overlapCast } from "@opensesame/os-domain";
import { page } from "../../ports.js";
/**
 * Additional vault unlock methods beyond the master password.
 *
 * Password wrap stays the classic path (VaultHeader.wrap). Passkey (WebAuthn PRF)
 * and PIN each store an alternate AES-GCM wrap of the same vault key. Optional
 * TOTP is a second factor after any primary unwrap — the TOTP seed is sealed
 * under the vault key so it is only readable after primary unlock succeeds.
 */

import {
  type CodeChannel,
  type KdfParams,
  MAX_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  type PasskeyUnlockRecord,
  type PinUnlockRecord,
  type RecoveryCodesRecord,
  SALT_BYTES,
  type SealedBlob,
  type TotpGateRecord,
  VaultCorruptError,
  type VaultHeader,
  type VaultUnlocks,
  WrongPasswordError,
  assertKdfParams,
  b64ToBytes,
  bytesToB64,
  parseTotp,
  randomBytes,
  totpCode,
} from "@opensesame/vault-core";
import {
  createPasskeyUnlockCeremonyDefault,
  getPasskeyUnlockCeremonyDefault,
  getPasskeyUnlockCeremonyForDefault,
} from "./protection/adapters/webauthn-prf-ceremony.js";
import {
  PrfCeremonyError,
  assertUsablePrfOutput,
} from "./protection/adapters/webauthn-prf-output.js";

export {
  type WebauthnHostCheck,
  WebauthnHostError,
  assertWebauthnHost,
  checkWebauthnHost,
  describeWebauthnError,
  formatWebauthnHostError,
  isIpHostname,
  localhostEquivalentHref,
  webauthnHostSeams,
  webauthnRpId,
} from "./webauthn-host.js";

export {
  MIN_PRF_OUTPUT_BYTES,
  PrfCeremonyError,
  type PrfCeremonyErrorCode,
  assertUsablePrfOutput,
  hasUsablePrfOutput,
  prfExtensionSupported,
  readPrfFirst,
  requirePrfOutputFromExtension,
} from "./protection/adapters/webauthn-prf-output.js";

const IV_BYTES = 12;
const PRF_INFO = new TextEncoder().encode("opensesame/vault/webauthn-prf/v1");

export const MIN_PIN_LENGTH = 8;
export const MAX_PIN_LENGTH = 12;
/** PIN wraps use at least the password floor; extra iterations raise offline cost. */
export const PIN_PBKDF2_ITERATIONS = 1_200_000;

export type {
  CodeChannel,
  PasskeyUnlockRecord,
  PinUnlockRecord,
  RecoveryCodesRecord,
  RemoteCodeRecord,
  TotpGateRecord,
  VaultUnlocks,
} from "@opensesame/vault-core";

/**
 * Passkey wraps present on a header. A legacy lone `passkey` migrates to a
 * one-element list; when both exist, `passkey` is prepended if its id is new.
 */
export function listPasskeyUnlockRecords(
  unlocks: VaultUnlocks | null | undefined,
): PasskeyUnlockRecord[] {
  if (!unlocks) return [];
  const fromArray = unlocks.passkeys ?? [];
  if (fromArray.length > 0) {
    const legacy = unlocks.passkey;
    if (
      legacy &&
      !fromArray.some((row) => row.credentialIdB64 === legacy.credentialIdB64)
    ) {
      return [legacy, ...fromArray];
    }
    return fromArray;
  }
  return unlocks.passkey ? [unlocks.passkey] : [];
}

export function findPasskeyUnlockRecord(
  unlocks: VaultUnlocks | null | undefined,
  credentialIdB64: string,
): PasskeyUnlockRecord | null {
  return (
    listPasskeyUnlockRecords(unlocks).find(
      (row) => row.credentialIdB64 === credentialIdB64,
    ) ?? null
  );
}

/**
 * Merge a successful enroll into unlocks without dropping other passkeys.
 * Same credential id replaces that row only (KP-23: failed enroll must not call this).
 */
export function withPasskeyUnlock(
  unlocks: VaultUnlocks | undefined,
  record: PasskeyUnlockRecord,
): VaultUnlocks {
  const existing = listPasskeyUnlockRecords(unlocks).filter(
    (row) => row.credentialIdB64 !== record.credentialIdB64,
  );
  const passkeys = [...existing, record];
  return {
    ...unlocks,
    passkey: passkeys[0],
    passkeys,
  };
}

/** Project legacy `passkey` into `passkeys` for durable multi-cred storage. */
export function normalizePasskeyUnlocks(unlocks: VaultUnlocks): VaultUnlocks {
  const passkeys = listPasskeyUnlockRecords(unlocks);
  if (passkeys.length === 0) {
    const { passkey: _p, passkeys: _ps, ...rest } = unlocks;
    return rest;
  }
  return {
    ...unlocks,
    passkey: passkeys[0],
    passkeys,
  };
}

/** A second step the vault asks for after the key. */
export type SecondStepId = "totp" | CodeChannel;

/** The second steps this vault enrolled, authenticator first. */
export function listSecondSteps(
  header: VaultHeader | null | undefined,
): SecondStepId[] {
  const steps: SecondStepId[] = [];
  if (header?.unlocks?.totp) steps.push("totp");
  if (header?.unlocks?.email) steps.push("email");
  if (header?.unlocks?.sms) steps.push("sms");
  return steps;
}

export function hasSecondStep(header: VaultHeader | null | undefined): boolean {
  return listSecondSteps(header).length > 0;
}

export type UnlockMethodId = "password" | "passkey" | "pin";

function listAvailableUnlockMethodsDefault(
  header: VaultHeader | null | undefined,
): UnlockMethodId[] {
  if (!header) return [];
  const methods: UnlockMethodId[] = [];
  if (listPasskeyUnlockRecords(header.unlocks).length > 0) {
    methods.push("passkey");
  }
  if (header.unlocks?.pin) methods.push("pin");
  if (header.wrap && header.kdf) methods.push("password");
  return methods;
}

function preferredUnlockMethodDefault(
  header: VaultHeader | null | undefined,
): UnlockMethodId | null {
  const methods = listAvailableUnlockMethods(header);
  if (methods.includes("passkey")) return "passkey";
  if (methods.includes("pin")) return "pin";
  if (methods.includes("password")) return "password";
  return null;
}

/** Every format problem a PIN has, in plain words, empty when it passes. */
export function pinPolicyProblems(pin: string): string[] {
  const normalized = pin.normalize("NFKC");
  const problems: string[] = [];
  if (
    normalized.length < MIN_PIN_LENGTH ||
    normalized.length > MAX_PIN_LENGTH
  ) {
    problems.push(
      `PIN must be ${MIN_PIN_LENGTH}–${MAX_PIN_LENGTH} characters.`,
    );
  }
  if (/\s/.test(normalized)) {
    problems.push("PIN cannot contain spaces.");
  }
  if (/^(.)\1+$/u.test(normalized)) {
    problems.push("PIN cannot be a repeated character.");
  }
  if (
    normalized.length > 1 &&
    ("01234567890123456789".includes(normalized) ||
      "98765432109876543210".includes(normalized))
  ) {
    problems.push("PIN cannot be a sequential run of digits.");
  }
  return problems;
}

export function assertPinPolicy(pin: string): void {
  const [first] = pinPolicyProblems(pin);
  if (first) throw new Error(first);
}

async function encryptWithKey(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<SealedBlob> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: overlapCast(iv) },
    key,
    overlapCast(plaintext),
  );
  return { ivB64: bytesToB64(iv), ctB64: bytesToB64(new Uint8Array(ct)) };
}

async function decryptWithKey(
  key: CryptoKey,
  blob: SealedBlob,
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: overlapCast(b64ToBytes(blob.ivB64)) },
    key,
    overlapCast(b64ToBytes(blob.ctB64)),
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
    { name: "PBKDF2", salt: overlapCast(salt), iterations, hash: "SHA-256" },
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
      salt: overlapCast(publicSalt),
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
  assertUsablePrfOutput(prfOutput);
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

export type PasskeyCeremony = {
  credential: PublicKeyCredential;
  prfOutput: ArrayBuffer;
  prfSalt: Uint8Array;
  userId: Uint8Array;
};

export type PasskeyUnlockCeremonyResult = {
  prfOutput: ArrayBuffer;
  record: PasskeyUnlockRecord;
  credentialIdB64: string;
};

export type PasskeyCeremonyGetOptions = {
  rpId?: string;
  signal?: AbortSignal | undefined;
  credentialIdB64?: string;
};

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

export const unlockMethodsSeams = {
  listAvailableUnlockMethods: listAvailableUnlockMethodsDefault,
  preferredUnlockMethod: preferredUnlockMethodDefault,
  createPasskeyUnlockCeremony: createPasskeyUnlockCeremonyDefault,
  getPasskeyUnlockCeremony: getPasskeyUnlockCeremonyDefault,
  getPasskeyUnlockCeremonyFor: getPasskeyUnlockCeremonyForDefault,
};

export function listAvailableUnlockMethods(
  header: VaultHeader | null | undefined,
): UnlockMethodId[] {
  return unlockMethodsSeams.listAvailableUnlockMethods(header);
}

export function preferredUnlockMethod(
  header: VaultHeader | null | undefined,
): UnlockMethodId | null {
  return unlockMethodsSeams.preferredUnlockMethod(header);
}

export async function createPasskeyUnlockCeremony(
  rpId?: string,
  signal?: AbortSignal,
): Promise<PasskeyCeremony> {
  return rpId === undefined
    ? unlockMethodsSeams.createPasskeyUnlockCeremony(undefined, signal)
    : unlockMethodsSeams.createPasskeyUnlockCeremony(rpId, signal);
}

export async function getPasskeyUnlockCeremony(
  record: PasskeyUnlockRecord,
  rpId?: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  return rpId === undefined
    ? unlockMethodsSeams.getPasskeyUnlockCeremony(record)
    : unlockMethodsSeams.getPasskeyUnlockCeremony(record, rpId, signal);
}

export async function getPasskeyUnlockCeremonyFor(
  records: PasskeyUnlockRecord[],
  options?: PasskeyCeremonyGetOptions,
): Promise<PasskeyUnlockCeremonyResult> {
  return unlockMethodsSeams.getPasskeyUnlockCeremonyFor(records, options);
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

/* ------------------------------------------------------------------ *
 * Sealed text and recovery codes
 * ------------------------------------------------------------------ */

export async function sealText(
  vaultKey: CryptoKey,
  text: string,
): Promise<SealedBlob> {
  return encryptWithKey(vaultKey, new TextEncoder().encode(text));
}

export async function openText(
  vaultKey: CryptoKey,
  blob: SealedBlob,
): Promise<string> {
  return new TextDecoder().decode(await decryptWithKey(vaultKey, blob));
}

export const RECOVERY_CODE_COUNT = 10;
/** Lowercase, no 0/1/l/o: a code is read off paper and typed, not pasted. */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Ten codes shaped `xxxx-xxxx`, 155 bits of alphabet each. */
export function randomRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(8);
    let code = "";
    for (const [index, byte] of bytes.entries()) {
      if (index === 4) code += "-";
      code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    }
    codes.push(code);
  }
  return codes;
}

/** A typed code, forgiven its case, spaces and dashes. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type RecoveryLedger = { codes: string[]; used: boolean[] };

export async function sealRecoveryLedger(
  vaultKey: CryptoKey,
  ledger: RecoveryLedger,
): Promise<SealedBlob> {
  return sealText(vaultKey, JSON.stringify(ledger));
}

export async function openRecoveryLedger(
  vaultKey: CryptoKey,
  record: RecoveryCodesRecord,
): Promise<RecoveryLedger> {
  const parsed = overlapCast(
    JSON.parse(await openText(vaultKey, record.codesWrap)),
  );
  const codes = Array.isArray(parsed.codes)
    ? parsed.codes.filter(isString)
    : [];
  const usedRaw = parsed.used;
  const used = Array.isArray(usedRaw)
    ? codes.map((_, i) => usedRaw[i] === true)
    : codes.map(() => false);
  return { codes, used };
}

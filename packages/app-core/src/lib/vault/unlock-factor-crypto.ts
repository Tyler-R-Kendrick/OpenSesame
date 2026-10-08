/** Fixed PIN/AES/text operations; no ceremony or owner authority. */
import { overlapCast } from "@opensesame/os-domain";
import {
  type PasskeyUnlockRecord,
  type PinUnlockRecord,
  SALT_BYTES,
  type SealedBlob,
  VaultCorruptError,
  type VaultUnlocks,
  WrongPasswordError,
  assertKdfParams,
  b64ToBytes,
  bytesToB64,
  randomBytes,
} from "@opensesame/vault-core";

import { assertUsablePrfOutput } from "./protection/adapters/webauthn-prf-output.js";

const IV_BYTES = 12;
const PRF_INFO = new TextEncoder().encode("opensesame/vault/webauthn-prf/v1");

export const MIN_PIN_LENGTH = 8;
export const MAX_PIN_LENGTH = 12;
/** PIN wraps use at least the password floor; extra iterations raise offline cost. */
export const PIN_PBKDF2_ITERATIONS = 1_200_000;

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

export async function encryptWithKey(
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

export async function decryptWithKey(
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
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: overlapCast(salt), iterations, hash: "SHA-256" },
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password.normalize("NFKC")),
      "PBKDF2",
      false,
      ["deriveKey"],
    ),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
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

/** Fixed PRF wrapping and exact record lookup, independent of ceremonies. */
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

import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
/**
 * Vault cryptography — WebCrypto only, no dependencies, no dev-only stand-ins.
 *
 * Master password → PBKDF2-SHA256 → master key (MK).
 * MK wraps a random 256-bit vault key (VK) with AES-GCM.
 * Alternate unlocks (PIN, WebAuthn PRF) store additional wraps of the same VK.
 * VK seals the item collection with AES-GCM.
 *
 * Only ciphertext reaches OPFS. The in-session CryptoKey is non-extractable;
 * enrollment uses a private raw copy held by VaultStore and wiped on lock.
 */

/** OWASP 2023 floor for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;
/** Above this, deriving is indistinguishable from a hung tab. */
export const MAX_PBKDF2_ITERATIONS = 10_000_000;
export const SALT_BYTES = 16;
const IV_BYTES = 12;
const VAULT_KEY_BYTES = 32;

export class WrongPasswordError extends Error {
  constructor(message = "That credential did not unlock the vault.") {
    super(message);
    this.name = "WrongPasswordError";
  }
}

export class VaultCorruptError extends Error {
  constructor(detail: string) {
    super(`The stored vault could not be read: ${detail}`);
    this.name = "VaultCorruptError";
  }
}

export type KdfParams = {
  alg: "PBKDF2-SHA256";
  saltB64: string;
  iterations: number;
};

/** Plaintext header — safe to store unencrypted; reveals no vault content. */
export type VaultHeader = {
  v: 1;
  /** Present when a master-password wrap is enrolled. */
  kdf?: KdfParams;
  /** AES-GCM(MK) over the raw vault key — password unlock. */
  wrap?: SealedBlob;
  /**
   * Alternate unlock wraps (passkey PRF, PIN) and optional TOTP second factor.
   * At least one of `wrap` or `unlocks.passkey` / `unlocks.pin` must exist.
   */
  unlocks?: import("./unlock-methods.js").VaultUnlocks;
  createdAt: string;
  /** Optional self-authored reminder. Never the password itself. */
  hint?: string;
  /**
   * Highest body revision written. Recorded after the body lands, so it trails a
   * newer body at worst; a body claiming less than this is an older copy.
   */
  bodyRev?: number;
};

export type SealedBlob = {
  ivB64: string;
  ctB64: string;
};

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

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

async function deriveMasterKey(
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

async function encrypt(
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

async function decrypt(key: CryptoKey, blob: SealedBlob): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: overlapCast(b64ToBytes(blob.ivB64)) },
    key,
    overlapCast(b64ToBytes(blob.ctB64)),
  );
  return new Uint8Array(plain);
}

export function assertKdfParams(kdf: KdfParams): void {
  if (kdf.alg !== "PBKDF2-SHA256") {
    throw new VaultCorruptError("unsupported key derivation");
  }
  if (
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < PBKDF2_ITERATIONS ||
    kdf.iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new VaultCorruptError("key derivation parameters were altered");
  }
  if (b64ToBytes(kdf.saltB64).length !== SALT_BYTES) {
    throw new VaultCorruptError("key derivation salt is the wrong size");
  }
}

export async function importVaultKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", overlapCast(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Random vault key with no wrap yet — caller enrolls passkey, PIN, and/or password. */
export async function mintVaultKey(): Promise<{
  vaultKey: CryptoKey;
  rawVaultKey: Uint8Array;
}> {
  const rawVaultKey = randomBytes(VAULT_KEY_BYTES);
  return { vaultKey: await importVaultKey(rawVaultKey), rawVaultKey };
}

/** Wipe a buffer we are done with. Best effort — JS strings cannot be wiped. */
function zero(bytes: Uint8Array): void {
  bytes.fill(0);
}

export type VaultKeyBundle = {
  header: VaultHeader;
  vaultKey: CryptoKey;
  /** Caller must zero after stashing. */
  rawVaultKey: Uint8Array;
};

/** First run: mint a vault key and wrap it under a new master password. */
export async function createVault(
  password: string,
  hint?: string,
): Promise<VaultKeyBundle> {
  const salt = randomBytes(SALT_BYTES);
  const masterKey = await deriveMasterKey(password, salt, PBKDF2_ITERATIONS);
  const rawVaultKey = randomBytes(VAULT_KEY_BYTES);
  const wrap = await encrypt(masterKey, rawVaultKey);
  const vaultKey = await importVaultKey(rawVaultKey);
  const header: VaultHeader = {
    v: 1,
    kdf: {
      alg: "PBKDF2-SHA256",
      saltB64: bytesToB64(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    wrap,
    createdAt: new Date().toISOString(),
    ...(hint ? { hint } : undefined),
  };
  return { header, vaultKey, rawVaultKey };
}

/** Unlock: derive MK from the password and unwrap VK. GCM tag verifies the password. */
export async function unwrapRawVaultKeyFromPassword(
  header: VaultHeader,
  password: string,
): Promise<Uint8Array> {
  if (header.v !== 1) {
    throw new VaultCorruptError("unsupported vault format");
  }
  if (!header.wrap || !header.kdf || header.kdf.alg !== "PBKDF2-SHA256") {
    throw new VaultCorruptError("this vault has no master-password unlock");
  }
  assertKdfParams(header.kdf);
  const masterKey = await deriveMasterKey(
    password,
    b64ToBytes(header.kdf.saltB64),
    header.kdf.iterations,
  );
  try {
    return await decrypt(masterKey, header.wrap);
  } catch {
    throw new WrongPasswordError();
  }
}

export async function unlockVaultKey(
  header: VaultHeader,
  password: string,
): Promise<CryptoKey> {
  const rawVaultKey = await unwrapRawVaultKeyFromPassword(header, password);
  const vaultKey = await importVaultKey(rawVaultKey);
  zero(rawVaultKey);
  return vaultKey;
}

/**
 * Re-wrap the same vault key under a new master password. Items are untouched,
 * so a password change never needs to decrypt and re-encrypt the collection.
 * Passkey / PIN / TOTP unlock records are preserved on the header.
 */
export async function rewrapVaultKey(
  header: VaultHeader,
  currentPassword: string,
  nextPassword: string,
  /** Omit to keep the existing hint; pass "" to clear it. */
  hint?: string,
): Promise<VaultHeader> {
  if (!header.wrap || !header.kdf || header.kdf.alg !== "PBKDF2-SHA256") {
    throw new VaultCorruptError("this vault has no master-password unlock");
  }
  assertKdfParams(header.kdf);
  const currentMaster = await deriveMasterKey(
    currentPassword,
    b64ToBytes(header.kdf.saltB64),
    header.kdf.iterations,
  );
  let rawVaultKey: Uint8Array;
  try {
    rawVaultKey = await decrypt(currentMaster, header.wrap);
  } catch {
    throw new WrongPasswordError();
  }

  const salt = randomBytes(SALT_BYTES);
  const nextMaster = await deriveMasterKey(
    nextPassword,
    salt,
    PBKDF2_ITERATIONS,
  );
  const wrap = await encrypt(nextMaster, rawVaultKey);
  zero(rawVaultKey);

  const nextHint = hint === undefined ? header.hint : hint;
  return {
    v: 1,
    kdf: {
      alg: "PBKDF2-SHA256",
      saltB64: bytesToB64(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    wrap,
    createdAt: header.createdAt,
    ...(header.unlocks ? { unlocks: header.unlocks } : undefined),
    ...(nextHint ? { hint: nextHint } : undefined),
    // The body is untouched by a re-key, so how far it has got carries over. A
    // fresh header would forget it and take the rollback check with it.
    ...(header.bodyRev !== undefined ? { bodyRev: header.bodyRev } : undefined),
  };
}

/** Wrap a raw vault key under a master password (enroll or re-add password unlock). */
export async function wrapVaultKeyWithPassword(
  rawVaultKey: Uint8Array,
  password: string,
): Promise<{ kdf: KdfParams; wrap: SealedBlob }> {
  const salt = randomBytes(SALT_BYTES);
  const masterKey = await deriveMasterKey(password, salt, PBKDF2_ITERATIONS);
  const wrap = await encrypt(masterKey, rawVaultKey);
  return {
    kdf: {
      alg: "PBKDF2-SHA256",
      saltB64: bytesToB64(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    wrap,
  };
}

export async function sealJson(
  vaultKey: CryptoKey,
  value: BoundaryValue,
): Promise<SealedBlob> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const blob = await encrypt(vaultKey, bytes);
  zero(bytes);
  return blob;
}

export async function openJson<T>(
  vaultKey: CryptoKey,
  blob: SealedBlob,
): Promise<T> {
  let bytes: Uint8Array;
  try {
    bytes = await decrypt(vaultKey, blob);
  } catch {
    throw new VaultCorruptError("authentication tag mismatch");
  }
  try {
    return overlapCast(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new VaultCorruptError("decrypted payload is not valid JSON");
  }
}

/** Guard used before any write to durable storage. */
export function assertSealed(blob: SealedBlob): void {
  if (!blob.ivB64 || !blob.ctB64) {
    throw new Error("refusing to persist an unsealed vault body");
  }
}

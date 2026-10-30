import { expand } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { argon2id } from "hash-wasm";
import { z } from "zod";

export type BitwardenKdf =
  | { kdfType: 0; iterations: number }
  | {
      kdfType: 1;
      iterations: number;
      memoryMiB: number;
      parallelism: number;
    };

/** Explicit caller policy, not server parameters or an automatic fallback. */
export interface BitwardenKdfResourceLimits {
  maxPbkdf2Iterations: number;
  maxArgon2Iterations: number;
  maxArgon2MemoryMiB: number;
  maxArgon2Parallelism: number;
}

const MAX_INPUT_BYTES = 4096;
const encoder = new TextEncoder();
const inputText = z.string().min(1).max(MAX_INPUT_BYTES);

function boundedInteger(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error("Invalid Bitwarden key derivation parameters.");
}

function validateLimits(limits: BitwardenKdfResourceLimits): void {
  if (!limits)
    throw new Error("Bitwarden key derivation resource policy is required.");
  // These upper bounds are this implementation's allocation/work policy,
  // not universal Bitwarden protocol maxima. Never silently lower work.
  boundedInteger(limits.maxPbkdf2Iterations, 5000, 2_000_000);
  boundedInteger(limits.maxArgon2Iterations, 2, 10);
  boundedInteger(limits.maxArgon2MemoryMiB, 16, 1024);
  boundedInteger(limits.maxArgon2Parallelism, 1, 16);
}

function snapshotKdf(
  kdf: BitwardenKdf,
  limits: BitwardenKdfResourceLimits,
): BitwardenKdf {
  validateLimits(limits);
  if (!kdf) throw new Error("Invalid Bitwarden key derivation parameters.");
  if (kdf.kdfType === 0) {
    boundedInteger(kdf.iterations, 5000, limits.maxPbkdf2Iterations);
    return { kdfType: 0, iterations: kdf.iterations };
  }
  if (kdf.kdfType !== 1)
    throw new Error("Unsupported Bitwarden key derivation algorithm.");
  boundedInteger(kdf.iterations, 2, limits.maxArgon2Iterations);
  boundedInteger(kdf.memoryMiB, 16, limits.maxArgon2MemoryMiB);
  boundedInteger(kdf.parallelism, 1, limits.maxArgon2Parallelism);
  return {
    kdfType: 1,
    iterations: kdf.iterations,
    memoryMiB: kdf.memoryMiB,
    parallelism: kdf.parallelism,
  };
}

/** Count UTF-8 before allocation; malformed scalar strings are rejected. */
function boundedTextBytes(text: string) {
  if (!inputText.safeParse(text).success)
    throw new Error("Invalid Bitwarden key derivation input.");
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error("Invalid Bitwarden key derivation input.");
      bytes += 4;
    } else {
      if (unit >= 0xdc00 && unit <= 0xdfff)
        throw new Error("Invalid Bitwarden key derivation input.");
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > MAX_INPUT_BYTES)
      throw new Error("Invalid Bitwarden key derivation input.");
  }
  return encoder.encode(text);
}

/** Only for legacy prelogin responses without an explicit modern salt. */
export function bitwardenLegacyEmailSalt(email: string): Uint8Array {
  if (!inputText.safeParse(email).success)
    throw new Error("Invalid Bitwarden key derivation input.");
  return boundedTextBytes(email.trim().toLowerCase());
}

async function derivePbkdf2(
  password: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    password,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Returns caller-owned master32. No password or supplied salt normalization.
 * Run in a disposable worker: terminating that worker is real cancellation.
 * Wiping our copies cannot erase JavaScript strings or primitive internals.
 */
export async function deriveBitwardenMasterKey(
  password: string,
  salt: Uint8Array,
  kdf: BitwardenKdf,
  limits: BitwardenKdfResourceLimits,
): Promise<Uint8Array> {
  const parameters = snapshotKdf(kdf, limits);
  if (
    !(salt instanceof Uint8Array) ||
    !salt.length ||
    salt.length > MAX_INPUT_BYTES
  )
    throw new Error("Invalid Bitwarden key derivation input.");
  const ownPassword = boundedTextBytes(password);
  const ownSalt = new Uint8Array(salt);
  let saltDigest: Uint8Array | undefined;
  try {
    if (parameters.kdfType === 0)
      return await derivePbkdf2(ownPassword, ownSalt, parameters.iterations);
    saltDigest = sha256(ownSalt);
    return await argon2id({
      password: ownPassword,
      salt: saltDigest,
      iterations: parameters.iterations,
      memorySize: parameters.memoryMiB * 1024,
      parallelism: parameters.parallelism,
      hashLength: 32,
      outputType: "binary",
    });
  } catch {
    throw new Error("Bitwarden key derivation failed.");
  } finally {
    ownPassword.fill(0);
    ownSalt.fill(0);
    saltDigest?.fill(0);
  }
}

/** RFC5869 Expand only: encryption32 followed by authentication32. */
export function stretchBitwardenMasterKey(masterKey: Uint8Array): Uint8Array {
  if (!(masterKey instanceof Uint8Array) || masterKey.length !== 32)
    throw new Error("Invalid Bitwarden master key.");
  const key = new Uint8Array(masterKey);
  let encryption: Uint8Array | undefined;
  let authentication: Uint8Array | undefined;
  try {
    encryption = expand(sha256, key, encoder.encode("enc"), 32);
    authentication = expand(sha256, key, encoder.encode("mac"), 32);
    const stretched = new Uint8Array(64);
    stretched.set(encryption);
    stretched.set(authentication, 32);
    return stretched;
  } finally {
    key.fill(0);
    encryption?.fill(0);
    authentication?.fill(0);
  }
}

/**
 * A password sealed under a pepper (ADR 0168). The pepper is something the
 * person types each time a password is used; it is never stored, so the sealed
 * body alone cannot produce the password.
 *
 * PBKDF2-SHA256 at the vault's own iteration floor stretches the pepper into an
 * AES-GCM key. The seal is bound to the account and method ids: moved to
 * another method, it fails to open.
 */

import { overlapCast } from "@opensesame/os-domain";
import type { PepperSeal } from "./account.js";
import { b64ToBytes, bytesToB64 } from "./bytes.js";
import {
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  VaultCorruptError,
  assertKdfParams,
  randomBytes,
} from "./crypto.js";
import { gcmOpen, gcmSeal } from "./gcm.js";

const IV_BYTES = 12;

export class WrongPepperError extends Error {
  constructor(message = "That pepper did not open this password.") {
    super(message);
    this.name = "WrongPepperError";
  }
}

export function pepperBinding(accountId: string, methodId: string): string {
  return `pepper-seal\u0000${accountId}\u0000${methodId}`;
}

async function pepperKey(
  pepper: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper.normalize("NFKC")),
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

export async function sealWithPepper(
  password: string,
  pepper: string,
  binding: string,
): Promise<PepperSeal> {
  if (pepper === "") throw new Error("A pepper cannot be empty.");
  const salt = randomBytes(SALT_BYTES);
  const key = await pepperKey(pepper, salt, PBKDF2_ITERATIONS);
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(password);
  const body = await gcmSeal(
    key,
    plaintext,
    iv,
    new TextEncoder().encode(binding),
  );
  plaintext.fill(0);
  return {
    v: 1,
    kdf: {
      alg: "PBKDF2-SHA256",
      saltB64: bytesToB64(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    seal: { ivB64: bytesToB64(iv), ctB64: bytesToB64(body) },
  };
}

/** Throws `WrongPepperError` for a wrong pepper or a seal moved to another method. */
export async function openWithPepper(
  sealed: PepperSeal,
  pepper: string,
  binding: string,
): Promise<string> {
  if (sealed.v !== 1) throw new VaultCorruptError("unknown pepper seal");
  assertKdfParams(sealed.kdf);
  const key = await pepperKey(
    pepper,
    b64ToBytes(sealed.kdf.saltB64),
    sealed.kdf.iterations,
  );
  let bytes: Uint8Array;
  try {
    bytes = await gcmOpen(
      key,
      b64ToBytes(sealed.seal.ivB64),
      b64ToBytes(sealed.seal.ctB64),
      new TextEncoder().encode(binding),
    );
  } catch {
    throw new WrongPepperError();
  }
  const text = new TextDecoder().decode(bytes);
  bytes.fill(0);
  return text;
}

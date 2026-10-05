/**
 * A password sealed under a pepper (ADR 0172). The pepper is something the
 * person types each time a password is used; it is never stored, so the sealed
 * body alone cannot produce the password.
 *
 * PBKDF2-SHA256 at the vault's own iteration floor stretches the pepper into an
 * AES-GCM wrapping key for a fresh per-password DEK. The seal is bound to the account and method ids: moved to
 * another method, it fails to open.
 */

import { isString, overlapCast } from "@opensesame/os-domain";
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
const DEK_BYTES = 32;
const TAG_BYTES = 16;
// v2 ciphertext: wrapping nonce | wrapped DEK + tag | payload + tag.
const HEADER_BYTES = IV_BYTES + DEK_BYTES + TAG_BYTES;

export class WrongPepperError extends Error {
  constructor(message = "That pepper did not open this password.") {
    super(message);
    this.name = "WrongPepperError";
  }
}

export function pepperBinding(accountId: string, methodId: string): string {
  return JSON.stringify(["pepper-seal", accountId, methodId]);
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

function context(sealed: PepperSeal, binding: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      "pepper-envelope",
      sealed.v,
      binding,
      sealed.kdf.alg,
      sealed.kdf.saltB64,
      sealed.kdf.iterations,
      sealed.seal.ivB64,
    ]),
  );
}

function joined(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function legacyBinding(binding: string): string {
  if (!binding.startsWith("[")) return binding;
  const parts = JSON.parse(binding);
  if (
    !Array.isArray(parts) ||
    parts.length !== 3 ||
    parts[0] !== "pepper-seal" ||
    !parts.every((part) => isString(part) && !part.includes("\u0000"))
  ) {
    throw new VaultCorruptError("ambiguous legacy pepper binding");
  }
  return parts.join("\u0000");
}

async function dataKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", overlapCast(bytes), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
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
  const sealed: PepperSeal = {
    v: 2,
    kdf: {
      alg: "PBKDF2-SHA256",
      saltB64: bytesToB64(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    seal: { ivB64: bytesToB64(iv), ctB64: "" },
  };
  const dek = randomBytes(DEK_BYTES);
  const plaintext = new TextEncoder().encode(password);
  try {
    const wrapIv = randomBytes(IV_BYTES);
    const aad = context(sealed, binding);
    const wrapped = await gcmSeal(key, dek, wrapIv, aad);
    const header = joined(wrapIv, wrapped);
    const body = await gcmSeal(
      await dataKey(dek),
      plaintext,
      iv,
      joined(aad, header),
    );
    sealed.seal.ctB64 = bytesToB64(joined(header, body));
    return sealed;
  } finally {
    dek.fill(0);
    plaintext.fill(0);
  }
}

/** The outer vault root supplies customer isolation; this nested seal adds a user factor. */
export async function openWithPepper(
  sealed: PepperSeal,
  pepper: string,
  binding: string,
): Promise<string> {
  if (sealed.v !== 1 && sealed.v !== 2)
    throw new VaultCorruptError("unknown pepper seal");
  assertKdfParams(sealed.kdf);
  const key = await pepperKey(
    pepper,
    b64ToBytes(sealed.kdf.saltB64),
    sealed.kdf.iterations,
  );
  let bytes: Uint8Array;
  try {
    const iv = b64ToBytes(sealed.seal.ivB64);
    const body = b64ToBytes(sealed.seal.ctB64);
    if (iv.length !== IV_BYTES) throw new Error("invalid pepper nonce");
    if (sealed.v === 1) {
      bytes = await gcmOpen(
        key,
        iv,
        body,
        new TextEncoder().encode(legacyBinding(binding)),
      );
    } else {
      if (body.length < HEADER_BYTES + TAG_BYTES)
        throw new Error("invalid pepper envelope");
      const aad = context(sealed, binding);
      const header = body.subarray(0, HEADER_BYTES);
      const dek = await gcmOpen(
        key,
        header.subarray(0, IV_BYTES),
        header.subarray(IV_BYTES),
        aad,
      );
      try {
        if (dek.length !== DEK_BYTES)
          throw new Error("invalid pepper data key");
        bytes = await gcmOpen(
          await dataKey(dek),
          iv,
          body.subarray(HEADER_BYTES),
          joined(aad, header),
        );
      } finally {
        dek.fill(0);
      }
    }
  } catch {
    throw new WrongPepperError();
  }
  try {
    return new TextDecoder().decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

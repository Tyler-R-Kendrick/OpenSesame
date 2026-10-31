/** A portable drop's separate code encrypts its manifest; it is never a UI-only gate. */
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  overlapCast,
 asBufferSource } from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";
import {
  MAX_CODE_CIPHERTEXT_CHARS,
  MAX_PORTABLE_CODE_CHARS,
  MAX_PORTABLE_MANIFEST_BYTES,
} from "./portable-drop-limits.js";

export const CODE_KDF = "PBKDF2-SHA256";
export const CODE_KDF_ITERATIONS = 600_000;
const encoder = new TextEncoder();

export type CodeSealedManifest = { nonce: string; ciphertext: string };
export type CodeBinding = {
  claimId: string;
  expiresAtMs: number;
  codeSalt: Uint8Array;
};

function associatedData(binding: CodeBinding): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "opensesame.portable-drop.manifest.v2",
      binding.claimId,
      binding.expiresAtMs,
      bytesToB64url(binding.codeSalt),
      CODE_KDF,
      CODE_KDF_ITERATIONS,
    ]),
  );
}

async function codeKey(code: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(code.trim()),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: asBufferSource(salt),
      iterations: CODE_KDF_ITERATIONS,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealCodeManifest(
  manifest: JsonObject,
  code: string,
  binding: CodeBinding,
): Promise<CodeSealedManifest> {
  const plaintext = encoder.encode(JSON.stringify(manifest));
  if (plaintext.byteLength > MAX_PORTABLE_MANIFEST_BYTES) {
    throw new Error("The portable drop manifest is too large.");
  }
  if (code.length > MAX_PORTABLE_CODE_CHARS) {
    throw new Error("The portable drop code is too long.");
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: asBufferSource(associatedData(binding)) },
    await codeKey(code, binding.codeSalt),
    plaintext,
  );
  return {
    nonce: bytesToB64url(nonce),
    ciphertext: bytesToB64url(new Uint8Array(ciphertext)),
  };
}

/** A wrong code cannot release a manifest, even to a client that skips attempt accounting. */
export async function openCodeManifest(
  sealed: CodeSealedManifest,
  code: string,
  binding: CodeBinding,
): Promise<JsonObject | null> {
  if (
    code.length > MAX_PORTABLE_CODE_CHARS ||
    binding.codeSalt.byteLength !== 16 ||
    sealed.nonce.length !== 16 ||
    sealed.ciphertext.length > MAX_CODE_CIPHERTEXT_CHARS
  )
    return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(b64urlToBytes(sealed.nonce)),
        additionalData: asBufferSource(associatedData(binding)),
      },
      await codeKey(code, binding.codeSalt),
      asBufferSource(b64urlToBytes(sealed.ciphertext)),
    );
    const manifest: BoundaryValue = overlapCast(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
    );
    return isJsonObject(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

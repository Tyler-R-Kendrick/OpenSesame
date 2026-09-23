/**
 * Shared cloud wrapping-secret envelope (C05 / C10).
 * KMS plaintext is always a fixed 32-byte wrapping secret.
 */

import { overlapCast } from "@opensesame/os-domain";
import { openRootCapsule, sealRootCapsule } from "./capsule.js";
import { ProtectionError } from "./errors.js";
import {
  DOMAIN_CLOUD_WRAP,
  ROOT_KEY_BYTES,
  WRAPPING_SECRET_BYTES,
} from "./limits.js";
import type { ProtectionContext, SealedBlobV1 } from "./types.js";

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type CloudLocalEnvelope = {
  wrappingSecret: Uint8Array;
  localCapsule: SealedBlobV1;
};

export async function deriveLocalKekFromWrappingSecret(
  wrappingSecret: Uint8Array,
): Promise<CryptoKey> {
  if (wrappingSecret.byteLength !== WRAPPING_SECRET_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Wrapping secret must be ${WRAPPING_SECRET_BYTES} bytes.`,
    );
  }
  const base = await crypto.subtle.importKey(
    "raw",
    overlapCast(wrappingSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(DOMAIN_CLOUD_WRAP),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createCloudLocalEnvelope(
  context: ProtectionContext,
  rootKey: Uint8Array,
): Promise<CloudLocalEnvelope> {
  if (rootKey.byteLength !== ROOT_KEY_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Root key must be ${ROOT_KEY_BYTES} bytes.`,
    );
  }
  const wrappingSecret = crypto.getRandomValues(
    new Uint8Array(WRAPPING_SECRET_BYTES),
  );
  const kek = await deriveLocalKekFromWrappingSecret(wrappingSecret);
  const localCapsule = await sealRootCapsule(kek, context, rootKey);
  return { wrappingSecret, localCapsule };
}

export async function openCloudLocalEnvelope(
  context: ProtectionContext,
  wrappingSecret: Uint8Array,
  localCapsule: SealedBlobV1,
): Promise<Uint8Array> {
  const kek = await deriveLocalKekFromWrappingSecret(wrappingSecret);
  return openRootCapsule(kek, context, localCapsule);
}

/** For transport captures / tests — wrapping secret is exactly 32 bytes. */
export function assertWrappingSecretTransportSize(secret: Uint8Array): void {
  if (secret.byteLength !== WRAPPING_SECRET_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `KMS wrapping payload must be ${WRAPPING_SECRET_BYTES} bytes, got ${secret.byteLength}.`,
    );
  }
}

export function wrappingSecretToB64(secret: Uint8Array): string {
  assertWrappingSecretTransportSize(secret);
  return bytesToB64(secret);
}

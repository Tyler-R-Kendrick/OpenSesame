/**
 * Manifest authentication: root-derived MAC over canonical manifest
 * excluding authB64. Mutable revision is included here, not in wrapper AAD.
 */

import { type JsonValue, overlapCast } from "@opensesame/os-domain";
import { canonicalizeToBytes } from "./canonicalize.js";
import { ProtectionError } from "./errors.js";
import { DOMAIN_MANIFEST_MAC } from "./limits.js";
import type { RootProtectionManifest } from "./types.js";

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function deriveManifestMacKey(
  rootKey: Uint8Array,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    overlapCast(rootKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(DOMAIN_MANIFEST_MAC),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export function manifestWithoutAuth(
  manifest: RootProtectionManifest,
): Omit<RootProtectionManifest, "authB64"> {
  const { authB64: _drop, ...rest } = manifest;
  return rest;
}

export async function authenticateManifest(
  rootKey: Uint8Array,
  manifest: Omit<RootProtectionManifest, "authB64">,
): Promise<string> {
  const key = await deriveManifestMacKey(rootKey);
  // SAFETY: RootProtectionManifest is JSON-shaped metadata; MAC excludes secrets.
  const payload: JsonValue = overlapCast(manifest);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    canonicalizeToBytes(payload),
  );
  return bytesToB64(new Uint8Array(sig));
}

export async function verifyManifestAuth(
  rootKey: Uint8Array,
  manifest: RootProtectionManifest,
): Promise<void> {
  if (!manifest.authB64) {
    throw new ProtectionError(
      "manifest_auth_failed",
      "Manifest authentication tag is missing.",
    );
  }
  const expected = await authenticateManifest(
    rootKey,
    manifestWithoutAuth(manifest),
  );
  if (!timingSafeEqual(b64ToBytes(expected), b64ToBytes(manifest.authB64))) {
    throw new ProtectionError(
      "manifest_auth_failed",
      "Manifest authentication failed.",
    );
  }
}

export async function sealAuthenticatedManifest(
  rootKey: Uint8Array,
  manifest: Omit<RootProtectionManifest, "authB64">,
): Promise<RootProtectionManifest> {
  const authB64 = await authenticateManifest(rootKey, manifest);
  return { ...manifest, authB64 };
}

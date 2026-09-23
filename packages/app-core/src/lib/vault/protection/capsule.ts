/**
 * Root capsule: context-bound AES-GCM package of the 32-byte vault root.
 * Mutable manifest revision is NEVER in capsule AAD (C04).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  DOMAIN_CAPSULE,
  type ProtectionContext,
  ROOT_KEY_BYTES,
  type SealedBlobV1,
} from "@opensesame/vault-core";
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
import { canonicalizeToBytes } from "./canonicalize.js";
import { ProtectionError } from "./errors.js";

export type RootCapsulePlaintext = {
  v: 1;
  domain: typeof DOMAIN_CAPSULE;
  context: ProtectionContext;
  rootKeyB64: string;
};

function contextAad(context: ProtectionContext): Uint8Array {
  return canonicalizeToBytes({
    domain: DOMAIN_CAPSULE,
    context,
  });
}

export async function sealRootCapsule(
  kek: CryptoKey,
  context: ProtectionContext,
  rootKey: Uint8Array,
  /** Fixed IV for cross-language vectors only. */
  ivOverride?: Uint8Array,
): Promise<SealedBlobV1> {
  if (rootKey.byteLength !== ROOT_KEY_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Root key must be ${ROOT_KEY_BYTES} bytes.`,
    );
  }
  if (ivOverride !== undefined && ivOverride.byteLength !== 12) {
    throw new ProtectionError("invalid_nonce", "Capsule IV must be 12 bytes.");
  }
  const plaintext: RootCapsulePlaintext = {
    v: 1,
    domain: DOMAIN_CAPSULE,
    context,
    rootKeyB64: bytesToB64(rootKey),
  };
  const iv = ivOverride ?? crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: overlapCast(contextAad(context)),
    },
    kek,
    canonicalizeToBytes(plaintext),
  );
  return { ivB64: bytesToB64(iv), ctB64: bytesToB64(new Uint8Array(ct)) };
}

function parseRootCapsulePlaintext(raw: ArrayBuffer): RootCapsulePlaintext {
  const decoded: BoundaryValue = JSON.parse(new TextDecoder().decode(raw));
  if (!isJsonObject(decoded)) {
    throw new ProtectionError(
      "malformed_encoding",
      "Root capsule plaintext is not an object.",
    );
  }
  if (decoded.v !== 1 || decoded.domain !== DOMAIN_CAPSULE) {
    throw new ProtectionError(
      "unsupported_version",
      "Unsupported root capsule version.",
    );
  }
  if (!isString(decoded.rootKeyB64)) {
    throw new ProtectionError(
      "malformed_encoding",
      "Root capsule rootKeyB64 is malformed.",
    );
  }
  if (!isJsonObject(decoded.context)) {
    throw new ProtectionError(
      "malformed_encoding",
      "Root capsule context is malformed.",
    );
  }
  const ctx = decoded.context;
  if (
    !isString(ctx.vaultId) ||
    !isString(ctx.rootKeyId) ||
    !isNumber(ctx.rootEpoch) ||
    !isString(ctx.protectorId) ||
    (ctx.purpose !== "human-vault-root" && ctx.purpose !== "workload-root")
  ) {
    throw new ProtectionError(
      "malformed_encoding",
      "Root capsule context fields are malformed.",
    );
  }
  return {
    v: 1,
    domain: DOMAIN_CAPSULE,
    context: {
      vaultId: ctx.vaultId,
      rootKeyId: ctx.rootKeyId,
      rootEpoch: ctx.rootEpoch,
      protectorId: ctx.protectorId,
      purpose: ctx.purpose,
    },
    rootKeyB64: decoded.rootKeyB64,
  };
}

export async function openRootCapsule(
  kek: CryptoKey,
  expected: ProtectionContext,
  sealed: SealedBlobV1,
): Promise<Uint8Array> {
  const iv = b64ToBytes(sealed.ivB64);
  if (iv.byteLength !== 12) {
    throw new ProtectionError("invalid_nonce", "Capsule IV must be 12 bytes.");
  }
  let raw: ArrayBuffer;
  try {
    raw = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: overlapCast(iv),
        additionalData: overlapCast(contextAad(expected)),
      },
      kek,
      overlapCast(b64ToBytes(sealed.ctB64)),
    );
  } catch {
    throw new ProtectionError(
      "capsule_auth_failed",
      "Root capsule authentication failed.",
    );
  }
  const parsed = parseRootCapsulePlaintext(raw);
  if (!contextsEqual(parsed.context, expected)) {
    throw new ProtectionError(
      "context_mismatch",
      "Root capsule context does not match expected protection context.",
    );
  }
  const rootKey = b64ToBytes(parsed.rootKeyB64);
  if (rootKey.byteLength !== ROOT_KEY_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Recovered root key must be ${ROOT_KEY_BYTES} bytes.`,
    );
  }
  return rootKey;
}

export function contextsEqual(
  left: ProtectionContext,
  right: ProtectionContext,
): boolean {
  return (
    left.vaultId === right.vaultId &&
    left.rootKeyId === right.rootKeyId &&
    left.rootEpoch === right.rootEpoch &&
    left.protectorId === right.protectorId &&
    left.purpose === right.purpose
  );
}

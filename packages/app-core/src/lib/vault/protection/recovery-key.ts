/**
 * High-entropy independent root recovery key (distinct from app OTP recovery codes).
 */

import { overlapCast } from "@opensesame/os-domain";
import {
  type ProtectionContext,
  ROOT_KEY_BYTES,
  type RecoveryKeyProtectorRecord,
  type SealedBlobV1,
} from "@opensesame/vault-core";
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
import { openRootCapsule, sealRootCapsule } from "./capsule.js";
import { ProtectionError } from "./errors.js";
import { newProtectorId } from "./ids.js";

const RECOVERY_INFO = new TextEncoder().encode(
  "opensesame/vault/recovery-key/v1",
);

async function kekFromRecoverySecret(secret: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    overlapCast(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: RECOVERY_INFO,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type GeneratedRecoveryKey = {
  /** Shown once — caller must present export ceremony. */
  secretB64: string;
  record: RecoveryKeyProtectorRecord;
  wrap: SealedBlobV1;
};

export async function enrollRecoveryKey(input: {
  context: ProtectionContext;
  rootKey: Uint8Array;
}): Promise<GeneratedRecoveryKey> {
  if (input.rootKey.byteLength !== ROOT_KEY_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Root key must be ${ROOT_KEY_BYTES} bytes.`,
    );
  }
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const fingerprint = await crypto.subtle.digest(
    "SHA-256",
    overlapCast(secret),
  );
  const kek = await kekFromRecoverySecret(secret);
  const protectorId = newProtectorId("recovery-key");
  const context: ProtectionContext = { ...input.context, protectorId };
  const wrap = await sealRootCapsule(kek, context, input.rootKey);
  const record: RecoveryKeyProtectorRecord = {
    kind: "recovery-key",
    protectorId,
    wrap,
    fingerprintB64: bytesToB64(new Uint8Array(fingerprint).slice(0, 8)),
    proofStatus: "verified",
  };
  return { secretB64: bytesToB64(secret), record, wrap };
}

export async function openWithRecoveryKey(input: {
  context: ProtectionContext;
  record: RecoveryKeyProtectorRecord;
  secretB64: string;
}): Promise<Uint8Array> {
  const secret = b64ToBytes(input.secretB64);
  try {
    const kek = await kekFromRecoverySecret(secret);
    return openRootCapsule(kek, input.context, input.record.wrap);
  } finally {
    secret.fill(0);
  }
}

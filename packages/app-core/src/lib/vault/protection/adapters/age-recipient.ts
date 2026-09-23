/**
 * Age-recipient root protector (KP-09, KP-26, KP-27).
 *
 * Encrypts the structured root capsule as an ordinary age payload to external
 * recipients. Verified enrollment requires an independent open proof.
 * Publishing without a private identity is allowed as `untested` and cannot
 * satisfy the last-verified guard (export for LIFECYCLE).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type AgeRecipientProtectorRecord,
  DOMAIN_CAPSULE,
  type ProtectionContext,
  ROOT_KEY_BYTES,
  type VerificationEvidence,
  b64ToBytes,
  bytesToB64,
} from "@opensesame/vault-core";
import {
  type AgeIdentityCustody,
  decryptWithAge,
  encryptWithAge,
  isAgeIdentity,
  isAgeRecipient,
} from "../../../age-keys.js";
import {
  type AuthorizedEnrollmentRequest,
  type AuthorizedOpenRequest,
  type AuthorizedProofRequest,
  type ClientRootKeyHandle,
  type KeyProtectorAdapter,
  type PendingProtection,
  type ProtectionProof,
  assertNotCanceled,
  assertSessionGeneration,
  mintRootKeyHandle,
} from "../adapter.js";
import { assertAgeRecoveryIndependent } from "../age-bootstrap.js";
import { canonicalizeToBytes } from "../canonicalize.js";
import { contextsEqual } from "../capsule.js";
import { ProtectionError } from "../errors.js";
import { newProtectorId } from "../ids.js";

export const AGE_ENCRYPTION_VERSION = "0.3.1";

export type AgeRecipientAdapterOptions = {
  recipients: string[];
  /**
   * Resolve an independently available identity at enroll/open time.
   * Must not depend on the vault being unlocked (KP-26).
   */
  resolveIdentity: () => Promise<string>;
  custody: AgeIdentityCustody;
  sessionGeneration: number;
};

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function requireRecipients(recipients: readonly string[]): string[] {
  const cleaned = [
    ...new Set(recipients.map((line) => line.trim()).filter(isAgeRecipient)),
  ];
  if (cleaned.length === 0) {
    throw new ProtectionError(
      "malformed_encoding",
      "Age recipient protector requires at least one valid recipient.",
    );
  }
  return cleaned;
}

export function buildPayload(
  context: ProtectionContext,
  rootKey: Uint8Array,
): Uint8Array {
  if (rootKey.byteLength !== ROOT_KEY_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Root key must be ${ROOT_KEY_BYTES} bytes.`,
    );
  }
  return canonicalizeToBytes({
    v: 1,
    domain: DOMAIN_CAPSULE,
    context,
    rootKeyB64: bytesToB64(rootKey),
  });
}

function parsePurpose(value: string): ProtectionContext["purpose"] {
  if (value === "human-vault-root" || value === "workload-root") return value;
  throw new ProtectionError(
    "context_mismatch",
    "Age root capsule purpose is unsupported.",
  );
}

function parsePayload(
  raw: Uint8Array,
  expected: ProtectionContext,
): Uint8Array {
  let body: BoundaryValue;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ProtectionError(
      "malformed_encoding",
      "Age root capsule payload is not valid JSON.",
    );
  }
  if (!isJsonObject(body)) {
    throw new ProtectionError(
      "malformed_encoding",
      "Age root capsule payload must be an object.",
    );
  }
  if (body.v !== 1 || body.domain !== DOMAIN_CAPSULE) {
    throw new ProtectionError(
      "unsupported_version",
      "Unsupported age root capsule version.",
    );
  }
  if (!isJsonObject(body.context)) {
    throw new ProtectionError(
      "context_mismatch",
      "Age root capsule missing protection context.",
    );
  }
  const ctx = body.context;
  if (
    !isString(ctx.vaultId) ||
    !isString(ctx.rootKeyId) ||
    !isNumber(ctx.rootEpoch) ||
    !isString(ctx.protectorId) ||
    !isString(ctx.purpose)
  ) {
    throw new ProtectionError(
      "context_mismatch",
      "Age root capsule context fields are invalid.",
    );
  }
  const parsedContext: ProtectionContext = {
    vaultId: ctx.vaultId,
    rootKeyId: ctx.rootKeyId,
    rootEpoch: ctx.rootEpoch,
    protectorId: ctx.protectorId,
    purpose: parsePurpose(ctx.purpose),
  };
  if (!contextsEqual(parsedContext, expected)) {
    throw new ProtectionError(
      "context_mismatch",
      "Age root capsule context does not match expected protection context.",
    );
  }
  if (!isString(body.rootKeyB64)) {
    throw new ProtectionError(
      "malformed_encoding",
      "Age root capsule missing root key.",
    );
  }
  const rootKey = b64ToBytes(body.rootKeyB64);
  if (rootKey.byteLength !== ROOT_KEY_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Recovered root key must be ${ROOT_KEY_BYTES} bytes.`,
    );
  }
  return rootKey;
}

export function softwareEvidence(evidenceRef: string): VerificationEvidence {
  return {
    kind: "software-roundtrip",
    implementationVersion: AGE_ENCRYPTION_VERSION,
    testedAt: new Date().toISOString(),
    evidenceRef,
  };
}

/**
 * LIFECYCLE helper (KP-27): untested public recipient grants cannot satisfy
 * the last-verified-path guard.
 */
export function ageRecipientCanSatisfyLastVerifiedGuard(
  record: AgeRecipientProtectorRecord,
): boolean {
  if (record.proofStatus !== "verified") return false;
  return record.lastEvidence != null;
}

/**
 * Publish a root wrapper to public recipients without a private identity.
 * Marked `untested` (KP-27).
 */
export type PublishUntestedAgeRecipientInput = {
  context: ProtectionContext;
  rootKey: Uint8Array;
  recipients: readonly string[];
  protectorId?: string;
};

export async function publishUntestedAgeRecipient(
  input: PublishUntestedAgeRecipientInput,
): Promise<AgeRecipientProtectorRecord> {
  const recipients = requireRecipients(input.recipients);
  const capsule = await encryptWithAge(
    buildPayload(input.context, input.rootKey),
    recipients,
  );
  return {
    kind: "age-recipient",
    protectorId: input.protectorId ?? newProtectorId("age-recipient"),
    recipients,
    capsuleAgeB64: bytesToB64(capsule),
    proofStatus: "untested",
  };
}

/** Compat alias for publishUntestedAgeRecipient. */
export async function enrollUntestedAgeRecipient(input: {
  context: ProtectionContext;
  rootKey: Uint8Array;
  recipient: string;
}): Promise<AgeRecipientProtectorRecord> {
  if (input.context.protectorId.length > 0) {
    return publishUntestedAgeRecipient({
      context: input.context,
      rootKey: input.rootKey,
      recipients: [input.recipient],
      protectorId: input.context.protectorId,
    });
  }
  return publishUntestedAgeRecipient({
    context: input.context,
    rootKey: input.rootKey,
    recipients: [input.recipient],
  });
}

export async function openAgeCapsule(
  record: AgeRecipientProtectorRecord,
  context: ProtectionContext,
  identity: string,
): Promise<Uint8Array> {
  if (!isAgeIdentity(identity)) {
    throw new ProtectionError(
      "unavailable",
      "Age identity required to open recipient protector.",
    );
  }
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptWithAge(
      b64ToBytes(record.capsuleAgeB64),
      identity,
    );
  } catch {
    throw new ProtectionError(
      "enrollment_proof_failed",
      "Age recipient capsule could not be opened with the supplied identity.",
    );
  }
  return parsePayload(plaintext, context);
}

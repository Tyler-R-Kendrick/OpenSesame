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

import type { AgeRecipientAdapterOptions } from "./age-recipient.js";
import {
  buildPayload,
  equalBytes,
  openAgeCapsule,
  requireRecipients,
  softwareEvidence,
} from "./age-recipient.js";

export function ageRecipientCapabilities() {
  return {
    implementation: "implemented" as const,
    runtime: "available" as const,
    authorization: "not-required" as const,
  };
}

export async function ageRecipientEnroll(
  options: AgeRecipientAdapterOptions,
  recipients: string[],
  custody: AgeRecipientAdapterOptions["custody"],
  sessionGeneration: number | undefined,
  request: AuthorizedEnrollmentRequest,
): Promise<PendingProtection> {
  assertNotCanceled(request.signal);
  assertSessionGeneration(sessionGeneration ?? 0, request.sessionGeneration);
  const identity = await options.resolveIdentity();
  if (!isAgeIdentity(identity)) {
    throw new ProtectionError(
      "unavailable",
      "Verified age enrollment requires an independently available identity.",
    );
  }
  assertAgeRecoveryIndependent({
    id: "enroll",
    recipient: recipients[0] ?? "",
    identity,
    custody,
  });
  const capsule = await encryptWithAge(
    buildPayload(request.context, request.rootHandle.bytes),
    recipients,
  );
  const candidate: AgeRecipientProtectorRecord = {
    kind: "age-recipient",
    protectorId: request.context.protectorId,
    recipients,
    capsuleAgeB64: bytesToB64(capsule),
    proofStatus: "untested",
  };
  const opened = await openAgeCapsule(candidate, request.context, identity);
  if (!equalBytes(opened, request.rootHandle.bytes)) {
    throw new ProtectionError(
      "enrollment_proof_failed",
      "Age enrollment proof recovered a different root key.",
    );
  }
  const evidence = softwareEvidence(
    `age-enroll:${request.context.protectorId}`,
  );
  const record: AgeRecipientProtectorRecord = {
    ...candidate,
    proofStatus: "verified",
    lastEvidence: evidence,
  };
  const proof: ProtectionProof = { ok: true, evidence };
  return { record, proof };
}

export async function ageRecipientProve(
  options: AgeRecipientAdapterOptions,
  sessionGeneration: number | undefined,
  request: AuthorizedProofRequest,
): Promise<ProtectionProof> {
  assertNotCanceled(request.signal);
  assertSessionGeneration(sessionGeneration ?? 0, request.sessionGeneration);
  if (request.record.kind !== "age-recipient") {
    throw new ProtectionError(
      "malformed_encoding",
      "Age adapter received a non-age record.",
    );
  }
  const identity = await options.resolveIdentity();
  await openAgeCapsule(request.record, request.context, identity);
  return {
    ok: true,
    evidence: softwareEvidence(`age-prove:${request.record.protectorId}`),
  };
}

export async function ageRecipientOpen(
  options: AgeRecipientAdapterOptions,
  sessionGeneration: number | undefined,
  request: AuthorizedOpenRequest,
): Promise<ClientRootKeyHandle> {
  assertNotCanceled(request.signal);
  assertSessionGeneration(sessionGeneration ?? 0, request.sessionGeneration);
  if (request.record.kind !== "age-recipient") {
    throw new ProtectionError(
      "malformed_encoding",
      "Age adapter received a non-age record.",
    );
  }
  const identity = await options.resolveIdentity();
  const rootKey = await openAgeCapsule(
    request.record,
    request.context,
    identity,
  );
  return mintRootKeyHandle(request.context, rootKey);
}

export function createAgeRecipientAdapter(
  options: AgeRecipientAdapterOptions,
): KeyProtectorAdapter {
  const recipients = requireRecipients(options.recipients);
  const custody = options.custody;
  const sessionGeneration = options.sessionGeneration;

  return {
    capabilities: ageRecipientCapabilities,
    enroll: (request) =>
      ageRecipientEnroll(
        options,
        recipients,
        custody,
        sessionGeneration,
        request,
      ),
    prove: (request) => ageRecipientProve(options, sessionGeneration, request),
    open: (request) => ageRecipientOpen(options, sessionGeneration, request),
    async dispose(): Promise<void> {
      // Identity resolution is caller-owned; nothing retained here.
    },
  };
}

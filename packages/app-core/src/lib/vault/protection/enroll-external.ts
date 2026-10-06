/**
 * Enrollment of the protectors whose key lives outside the browser session:
 * an age recipient, an AWS KMS key, a Google Cloud KMS key.
 *
 * Every record built here has been opened again before it is returned — the
 * same root key must come back out of the capsule through the same road a
 * recovery would use — or, for a recipient the person holds no identity for,
 * it is published `untested` and counts for nothing until a Test proves it
 * (KP-27).
 */

import type {
  AgeRecipientProtectorRecord,
  ProtectionContext,
  ProtectionRecord,
  RootProtectionManifest,
  VerificationEvidence,
} from "@opensesame/vault-core";
import {
  generateAgeKeyPair,
  isAgeIdentity,
  isAgeRecipient,
} from "../../age-keys.js";
import { assertNotCanceled, mintRootKeyHandle } from "./adapter.js";
import { createAgeRecipientAdapter } from "./adapters/age-recipient-ops.js";
import { publishUntestedAgeRecipient } from "./adapters/age-recipient.js";
import type { AwsKmsConnection, GcpKmsConnection } from "./cloud-connection.js";
import { ProtectionError } from "./errors.js";
import { newProtectorId } from "./ids.js";

export const CLOUD_WRAP_VERSION = "opensesame-cloud-wrap/1";
const MAX_RECIPIENTS = 16;

export type AgeRecipientEnrollment = {
  kind: "age-recipient";
  /** Public recipients. None: a fresh key pair is minted here. */
  recipients?: readonly string[];
  /** The private identity that proves the capsule opens. Never stored. */
  identity?: string;
  /** Identities this vault seals: not an independent way back in (KP-26). */
  vaultSealedIdentities?: readonly string[];
};

export type AwsKmsEnrollment = { kind: "aws-kms" } & AwsKmsConnection;
export type GcpKmsEnrollment = { kind: "gcp-kms" } & GcpKmsConnection;

export type ExternalEnrollment =
  | AgeRecipientEnrollment
  | AwsKmsEnrollment
  | GcpKmsEnrollment;

export type ExternalEnrollmentInput = {
  enrollment: ExternalEnrollment;
  base: RootProtectionManifest;
  rootKey: Uint8Array;
  operationId: string;
  sessionGeneration: number;
  signal: AbortSignal;
  context: (protectorId: string) => ProtectionContext;
};

export type ExternalEnrollmentResult = {
  record: ProtectionRecord;
  /** The minted age identity, shown once and never persisted. */
  ageIdentitySecret?: string;
};

export function cloudEvidence(evidenceRef: string): VerificationEvidence {
  return {
    kind: "cloud-live",
    implementationVersion: CLOUD_WRAP_VERSION,
    testedAt: new Date().toISOString(),
    evidenceRef,
  };
}

export function rootsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Split pasted recipients on whitespace; a line that is not one is refused. */
export async function parseRecipients(
  input: readonly string[],
): Promise<string[]> {
  const seen = new Set<string>();
  for (const raw of input) {
    for (const line of raw.split(/\s+/)) {
      const recipient = line.trim();
      if (recipient.length === 0) continue;
      if (!(await isAgeRecipient(recipient))) {
        throw new ProtectionError(
          "malformed_encoding",
          "That is not an age recipient (age1…).",
        );
      }
      seen.add(recipient);
    }
  }
  if (seen.size > MAX_RECIPIENTS) {
    throw new ProtectionError(
      "malformed_encoding",
      `An age protector takes at most ${MAX_RECIPIENTS} recipients.`,
    );
  }
  return [...seen];
}

function refuseDuplicate(
  base: RootProtectionManifest,
  same: (record: ProtectionRecord) => boolean,
  what: string,
): void {
  if (base.records.some(same)) {
    throw new ProtectionError(
      "duplicate_protector_id",
      `${what} is already enrolled on this vault.`,
    );
  }
}

async function enrollAgeRecipient(
  input: ExternalEnrollmentInput,
  enrollment: AgeRecipientEnrollment,
): Promise<ExternalEnrollmentResult> {
  let recipients = await parseRecipients(enrollment.recipients ?? []);
  let identity = enrollment.identity?.trim() ?? "";
  let ageIdentitySecret: string | undefined;
  if (recipients.length === 0) {
    if (identity.length > 0) {
      throw new ProtectionError(
        "malformed_encoding",
        "An identity needs the recipient it belongs to.",
      );
    }
    const pair = await generateAgeKeyPair();
    recipients = [pair.recipient];
    identity = pair.identity;
    ageIdentitySecret = pair.identity;
  }
  const key = [...recipients].sort().join("\n");
  refuseDuplicate(
    input.base,
    (record) =>
      record.kind === "age-recipient" &&
      [...record.recipients].sort().join("\n") === key,
    "That age recipient",
  );
  const protectorId = newProtectorId("age-recipient");
  const context = input.context(protectorId);
  if (identity.length === 0) {
    const record: AgeRecipientProtectorRecord =
      await publishUntestedAgeRecipient({
        context,
        rootKey: input.rootKey,
        recipients,
        protectorId,
      });
    return { record };
  }
  if (!(await isAgeIdentity(identity))) {
    throw new ProtectionError(
      "malformed_encoding",
      "That is not an age identity (AGE-SECRET-KEY-1…).",
    );
  }
  const vaultSealed = enrollment.vaultSealedIdentities?.includes(identity);
  const adapter = await createAgeRecipientAdapter({
    recipients,
    resolveIdentity: async () => identity,
    custody: vaultSealed ? "vault-sealed" : "external",
    sessionGeneration: input.sessionGeneration,
  });
  const pending = await adapter.enroll({
    operationId: input.operationId,
    sessionGeneration: input.sessionGeneration,
    context,
    rootHandle: mintRootKeyHandle(context, input.rootKey),
    signal: input.signal,
  });
  await adapter.dispose();
  return ageIdentitySecret === undefined
    ? { record: pending.record }
    : { record: pending.record, ageIdentitySecret };
}

async function enrollAwsKms(
  input: ExternalEnrollmentInput,
  enrollment: AwsKmsEnrollment,
): Promise<ExternalEnrollmentResult> {
  refuseDuplicate(
    input.base,
    (record) =>
      record.kind === "aws-kms" && record.keyArn === enrollment.keyArn,
    "That AWS KMS key",
  );
  const protectorId = newProtectorId("aws-kms");
  const context = input.context(protectorId);
  const { createAwsKmsProtector } = await import("./adapters/aws-kms.js");
  assertNotCanceled(input.signal);
  const protector = createAwsKmsProtector({
    transport: enrollment.transport,
    authorization: "authorized",
  });
  const wrapped = await protector.wrap({
    context,
    rootKey: input.rootKey,
    keyArn: enrollment.keyArn,
    region: enrollment.region,
    connectionId: enrollment.connectionId,
    connectionConfigVersion: enrollment.connectionConfigVersion,
  });
  const opened = await protector.unwrap({ context, record: wrapped.record });
  try {
    if (!rootsEqual(opened, input.rootKey)) {
      throw new ProtectionError(
        "enrollment_proof_failed",
        "AWS KMS enrollment recovered a different root key.",
      );
    }
  } finally {
    opened.fill(0);
  }
  return {
    record: {
      ...wrapped.record,
      proofStatus: "verified",
      lastEvidence: cloudEvidence(`aws-kms-enroll:${protectorId}`),
    },
  };
}

async function enrollGcpKms(
  input: ExternalEnrollmentInput,
  enrollment: GcpKmsEnrollment,
): Promise<ExternalEnrollmentResult> {
  refuseDuplicate(
    input.base,
    (record) =>
      record.kind === "gcp-kms" && record.keyName === enrollment.keyName,
    "That Google Cloud KMS key",
  );
  const protectorId = newProtectorId("gcp-kms");
  const context = input.context(protectorId);
  const { createGcpKmsProtector } = await import("./adapters/gcp-kms.js");
  assertNotCanceled(input.signal);
  const protector = createGcpKmsProtector({
    transport: enrollment.transport,
    authorization: "authorized",
  });
  const wrapped = await protector.wrap({
    context,
    rootKey: input.rootKey,
    keyName: enrollment.keyName,
    connectionId: enrollment.connectionId,
    connectionConfigVersion: enrollment.connectionConfigVersion,
  });
  const opened = await protector.unwrap({ context, record: wrapped.record });
  try {
    if (!rootsEqual(opened, input.rootKey)) {
      throw new ProtectionError(
        "enrollment_proof_failed",
        "Google Cloud KMS enrollment recovered a different root key.",
      );
    }
  } finally {
    opened.fill(0);
  }
  return {
    record: {
      ...wrapped.record,
      proofStatus: "verified",
      lastEvidence: cloudEvidence(`gcp-kms-enroll:${protectorId}`),
    },
  };
}

export function provenExternalRecord(
  input: ExternalEnrollmentInput,
): Promise<ExternalEnrollmentResult> {
  const { enrollment } = input;
  switch (enrollment.kind) {
    case "age-recipient":
      return enrollAgeRecipient(input, enrollment);
    case "aws-kms":
      return enrollAwsKms(input, enrollment);
    case "gcp-kms":
      return enrollGcpKms(input, enrollment);
  }
}

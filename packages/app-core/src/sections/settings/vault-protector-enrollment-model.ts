/**
 * View-model logic for enrolling and proving the protectors that name a key
 * outside the session — an age recipient, an AWS KMS key, a Google Cloud KMS
 * key (ADR 0133 §8): no React, no DOM, so any shell can drive the same flow.
 *
 * Each flow stages a candidate, has the person's own material prove it, and
 * only then commits. Nothing here keeps a secret: an identity, a credential or
 * a token lives in a local variable for the length of one call.
 */

import { type AgeIdentityEntry, readAgeKeyConfig } from "../../lib/age-keys.js";
import {
  readAwsKmsConfig,
  writeAwsKmsConfig,
} from "../../lib/aws-kms-config.js";
import {
  readGcpKmsConfig,
  writeGcpKmsConfig,
} from "../../lib/gcp-kms-config.js";
import type { VaultProtectionBrowserService } from "../../lib/vault/protection/browser-service.js";
import {
  awsKmsConnection,
  gcpKmsConnection,
} from "../../lib/vault/protection/cloud-connection.js";
import type { AgeRecipientEnrollment } from "../../lib/vault/protection/enroll-external.js";
import type { ProofMaterial } from "../../lib/vault/protection/protector-proof.js";

type Protection = Pick<
  VaultProtectionBrowserService,
  "enrollExternal" | "commitEnrollment" | "testProtector"
>;

export type EnrolledProtector = {
  protectorId: string;
  /** Verified at enrollment, or published untested until a Test proves it. */
  proven: boolean;
};

/** The private identities this vault seals: not a way back in (KP-26). */
async function vaultSealedIdentities(tomb: string): Promise<string[]> {
  const { identities } = await readAgeKeyConfig(tomb);
  return identities
    .filter(
      (row: AgeIdentityEntry) => row.custody === "vault-sealed" && row.identity,
    )
    .map((row) => row.identity ?? "");
}

export type AgeRecipientEntry = {
  /** Pasted recipients. Empty: a new key pair is made here. */
  recipient: string;
  /** The identity that proves a pasted recipient. Empty: published untested. */
  identity: string;
};

/**
 * `deliver` receives the identity of a key pair made here. It must put the
 * identity where the person keeps it (a file they save) — the record commits
 * only after it returns, so an identity that could not be handed over never
 * becomes the vault's way back in.
 */
export async function enrollAgeRecipientFlow(input: {
  protection: Protection;
  tomb: string;
  entry: AgeRecipientEntry;
  deliver: (delivery: { identity: string; recipient: string }) => void;
}): Promise<EnrolledProtector> {
  const recipients = input.entry.recipient.trim();
  const identity = input.entry.identity.trim();
  const enrollment: AgeRecipientEnrollment = {
    kind: "age-recipient",
    vaultSealedIdentities: await vaultSealedIdentities(input.tomb),
  };
  if (recipients) enrollment.recipients = [recipients];
  if (identity) enrollment.identity = identity;
  const candidate = await input.protection.enrollExternal(enrollment);
  if (
    candidate.ageIdentitySecret &&
    candidate.record.kind === "age-recipient"
  ) {
    input.deliver({
      identity: candidate.ageIdentitySecret,
      recipient: candidate.record.recipients.join("\n"),
    });
  }
  await input.protection.commitEnrollment(candidate.operationId);
  return {
    protectorId: candidate.record.protectorId,
    proven: candidate.record.proofStatus === "verified",
  };
}

export type AwsKmsEntry = {
  keyArn: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  label: string;
};

/** Save what changed on the connection, then read it back as it is sealed. */
export async function enrollAwsKmsFlow(input: {
  protection: Protection;
  tomb: string;
  entry: AwsKmsEntry;
  fetchImpl?: typeof fetch;
}): Promise<EnrolledProtector> {
  const saved = await readAwsKmsConfig(input.tomb);
  const configured = saved.keyArn !== "" && saved.secretAccessKey !== "";
  const { entry } = input;
  const changed =
    !configured ||
    entry.secretAccessKey.trim() !== "" ||
    entry.keyArn.trim() !== saved.keyArn ||
    entry.accessKeyId.trim() !== saved.accessKeyId ||
    (entry.sessionToken.trim() || null) !== saved.sessionToken;
  if (changed) {
    await writeAwsKmsConfig(input.tomb, {
      ...entry,
      keepExistingSecret: configured,
    });
  }
  const connection = await awsKmsConnection(input.tomb, input.fetchImpl);
  const candidate = await input.protection.enrollExternal({
    kind: "aws-kms",
    ...connection,
  });
  await input.protection.commitEnrollment(candidate.operationId);
  return { protectorId: candidate.record.protectorId, proven: true };
}

export type GcpKmsEntry = {
  keyName: string;
  projectId: string;
  serviceAccountJson: string;
  label: string;
};

export async function enrollGcpKmsFlow(input: {
  protection: Protection;
  tomb: string;
  entry: GcpKmsEntry;
  fetchImpl?: typeof fetch;
}): Promise<EnrolledProtector> {
  const saved = await readGcpKmsConfig(input.tomb);
  const configured = saved.keyName !== "" && saved.serviceAccountJson !== "";
  const { entry } = input;
  const changed =
    !configured ||
    entry.serviceAccountJson.trim() !== "" ||
    entry.keyName.trim() !== saved.keyName;
  if (changed) {
    await writeGcpKmsConfig(input.tomb, {
      ...entry,
      keepExistingSecret: configured,
    });
  }
  const connection = await gcpKmsConnection(input.tomb, input.fetchImpl);
  const candidate = await input.protection.enrollExternal({
    kind: "gcp-kms",
    ...connection,
  });
  await input.protection.commitEnrollment(candidate.operationId);
  return { protectorId: candidate.record.protectorId, proven: true };
}

/** Prove an age recipient with the identity the person supplies now. */
export async function testAgeRecipientFlow(input: {
  protection: Protection;
  tomb: string;
  protectorId: string;
  identity: string;
}): Promise<void> {
  await input.protection.testProtector(input.protectorId, {
    ageIdentity: input.identity.trim(),
    vaultSealedIdentities: await vaultSealedIdentities(input.tomb),
  });
}

/** Prove a cloud protector with the connection saved on this device. */
export async function testCloudFlow(input: {
  protection: Protection;
  tomb: string;
  protectorId: string;
  kind: "aws-kms" | "gcp-kms";
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const material: ProofMaterial =
    input.kind === "aws-kms"
      ? { aws: await awsKmsConnection(input.tomb, input.fetchImpl) }
      : { gcp: await gcpKmsConnection(input.tomb, input.fetchImpl) };
  await input.protection.testProtector(input.protectorId, material);
}

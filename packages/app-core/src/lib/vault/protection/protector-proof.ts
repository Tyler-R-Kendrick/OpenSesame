/**
 * Prove an enrolled protector by opening its capsule again and comparing what
 * comes out with the root this session holds.
 *
 * A proof is only offered for a kind whose capsule can be opened from this
 * page with something the person supplies at that moment — the recovery
 * secret, an age identity, their own cloud credential, their passkey. Password,
 * PIN and passkey wraps are proved by unlocking with them, and the rest have no
 * road in a browser (docs/adr/0152), so the service refuses to "test" them and
 * the panel does not draw the key.
 */

import type {
  ProtectionContext,
  ProtectionRecord,
  ProtectorKind,
  VerificationEvidence,
} from "@opensesame/vault-core";
import {
  AGE_ENCRYPTION_VERSION,
  openAgeCapsule,
} from "./adapters/age-recipient.js";
import {
  type AgeWebauthnCrypto,
  openAgeWebauthn,
} from "./adapters/age-webauthn.js";
import { createAwsKmsProtector } from "./adapters/aws-kms.js";
import { createGcpKmsProtector } from "./adapters/gcp-kms.js";
import type { AwsKmsConnection, GcpKmsConnection } from "./cloud-connection.js";
import { cloudEvidence, rootsEqual } from "./enroll-external.js";
import { ProtectionError } from "./errors.js";
import { openWithRecoveryKey } from "./recovery-key.js";

export type ProofMaterial = {
  recoverySecretB64?: string;
  /** An age identity typed or pasted for this test; held only for the call. */
  ageIdentity?: string;
  vaultSealedIdentities?: readonly string[];
  aws?: AwsKmsConnection;
  gcp?: GcpKmsConnection;
  /** Test seam for the passkey ceremony; the real one runs when absent. */
  ageWebauthnCrypto?: AgeWebauthnCrypto;
};

const TESTABLE: ReadonlySet<ProtectorKind> = new Set([
  "recovery-key",
  "age-recipient",
  "age-webauthn",
  "aws-kms",
  "gcp-kms",
]);

/** The kinds `testProtector` accepts — the panel draws Test for these only. */
export function protectorCanBeTested(kind: ProtectorKind): boolean {
  return TESTABLE.has(kind);
}

function softwareEvidence(
  record: ProtectionRecord,
  version: string,
): VerificationEvidence {
  return {
    kind: "software-roundtrip",
    implementationVersion: version,
    testedAt: new Date().toISOString(),
    evidenceRef: `${record.kind}-test:${record.protectorId}`,
  };
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === "") {
    throw new ProtectionError("unavailable", what);
  }
  return value;
}

async function openRoot(
  record: ProtectionRecord,
  context: ProtectionContext,
  material: ProofMaterial,
): Promise<Uint8Array> {
  switch (record.kind) {
    case "recovery-key":
      return openWithRecoveryKey({
        context,
        record,
        secretB64: need(
          material.recoverySecretB64,
          "Recovery-key test requires the shown-once secret.",
        ),
      });
    case "age-recipient": {
      const identity = need(
        material.ageIdentity,
        "An age identity is needed to open this protector.",
      ).trim();
      if (material.vaultSealedIdentities?.includes(identity)) {
        throw new ProtectionError(
          "bootstrap_cycle",
          "An identity this vault seals is not an independent way back in.",
        );
      }
      return openAgeCapsule(record, context, identity);
    }
    case "age-webauthn":
      return openAgeWebauthn(
        material.ageWebauthnCrypto
          ? { context, record, crypto: material.ageWebauthnCrypto }
          : { context, record },
      );
    case "aws-kms": {
      const aws = need(material.aws, "AWS KMS credentials are not saved.");
      if (aws.keyArn !== record.keyArn) {
        throw new ProtectionError(
          "context_mismatch",
          "The saved AWS KMS connection names a different key than this protector.",
        );
      }
      return createAwsKmsProtector({
        transport: aws.transport,
        authorization: "authorized",
      }).unwrap({ context, record });
    }
    case "gcp-kms": {
      const gcp = need(
        material.gcp,
        "Google Cloud KMS credentials are not saved.",
      );
      if (gcp.keyName !== record.keyName) {
        throw new ProtectionError(
          "context_mismatch",
          "The saved Google Cloud KMS connection names a different key than this protector.",
        );
      }
      return createGcpKmsProtector({
        transport: gcp.transport,
        authorization: "authorized",
      }).unwrap({ context, record });
    }
    default:
      throw new ProtectionError(
        "unavailable",
        `Protector kind ${record.kind} cannot be tested from a browser.`,
      );
  }
}

/** The record as proved now: verified, with the evidence of this proof. */
export async function proveRecord(input: {
  record: ProtectionRecord;
  context: ProtectionContext;
  rootKey: Uint8Array;
  material: ProofMaterial;
}): Promise<ProtectionRecord> {
  const { record, context, rootKey, material } = input;
  const opened = await openRoot(record, context, material);
  try {
    if (!rootsEqual(opened, rootKey)) {
      throw new ProtectionError(
        "enrollment_proof_failed",
        "That protector opens a different root key than this vault's.",
      );
    }
  } finally {
    opened.fill(0);
  }
  switch (record.kind) {
    case "aws-kms": {
      const aws = need(material.aws, "AWS KMS credentials are not saved.");
      return {
        ...record,
        connectionConfigVersion: aws.connectionConfigVersion,
        proofStatus: "verified",
        lastEvidence: cloudEvidence(`aws-kms-test:${record.protectorId}`),
      };
    }
    case "gcp-kms": {
      const gcp = need(
        material.gcp,
        "Google Cloud KMS credentials are not saved.",
      );
      return {
        ...record,
        connectionConfigVersion: gcp.connectionConfigVersion,
        proofStatus: "verified",
        lastEvidence: cloudEvidence(`gcp-kms-test:${record.protectorId}`),
      };
    }
    case "age-recipient":
      return {
        ...record,
        proofStatus: "verified",
        lastEvidence: softwareEvidence(record, AGE_ENCRYPTION_VERSION),
      };
    default:
      return {
        ...record,
        proofStatus: "verified",
        lastEvidence: softwareEvidence(record, "opensesame-protector/1"),
      };
  }
}

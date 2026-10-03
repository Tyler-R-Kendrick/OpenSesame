/**
 * Last-verified-path guard and revision-checked mutation helpers (C08, KP-11).
 */

import type {
  ProtectionRecord,
  RootProtectionManifest,
} from "@opensesame/vault-core";
import { ProtectionError } from "./errors.js";

/**
 * True when opening this protector needs something that is sealed inside the
 * vault it protects, so it can never be the way back in to that vault.
 *
 * Proof and bootstrap independence are two facts (ADR 0152). A cloud-KMS
 * capsule round-trips honestly — `proofStatus` says so — but the browser holds
 * its provider credential under Connections, sealed in this same vault
 * (ADR 0149, KP-37). It is a path for a principal who keeps that credential
 * elsewhere, not for the person locked out. An age recipient only ever reaches
 * `verified` through an identity held outside the vault (a vault-sealed one is
 * refused, KP-26); passwords, PINs, passkeys, the recovery key and hardware
 * open their capsule from what the person presents.
 *
 * The answer is a function of the kind, so manifests written before this
 * check keep their bytes, their authentication tag and their meaning.
 */
export function dependsOnVault(record: ProtectionRecord): boolean {
  switch (record.kind) {
    case "aws-kms":
    case "gcp-kms":
    case "azure-key-vault-keys":
      return true;
    case "password":
    case "pin":
    case "webauthn-prf":
    case "device-local":
    case "age-recipient":
    case "age-webauthn":
    case "yubikey-piv-age":
    case "recovery-key":
      return false;
    default: {
      const _exhaustive: never = record;
      return _exhaustive;
    }
  }
}

/**
 * Proved by a round trip AND able to open the vault without anything sealed in
 * it. Untested recipients and cloud capsules keyed from the vault never count.
 */
export function isVerifiedIndependentPath(record: ProtectionRecord): boolean {
  return record.proofStatus === "verified" && !dependsOnVault(record);
}

export function verifiedIndependentRecords(
  manifest: RootProtectionManifest,
): ProtectionRecord[] {
  return manifest.records.filter(isVerifiedIndependentPath);
}

export function assertCanRemoveProtector(
  manifest: RootProtectionManifest,
  protectorId: string,
): void {
  const target = manifest.records.find((r) => r.protectorId === protectorId);
  if (!target) {
    throw new ProtectionError(
      "malformed_encoding",
      `Protector ${protectorId} is not enrolled.`,
    );
  }
  const verified = verifiedIndependentRecords(manifest);
  const removingLastVerified =
    isVerifiedIndependentPath(target) && verified.length <= 1;
  if (removingLastVerified) {
    throw new ProtectionError(
      "last_verified_path",
      "Refusing to remove or replace the last verified independent unlock path. A cloud key whose credential is sealed in this vault does not count.",
    );
  }
}

export function assertExpectedRevision(
  manifest: RootProtectionManifest,
  expectedRevision: number,
): void {
  if (manifest.revision !== expectedRevision) {
    throw new ProtectionError(
      "revision_conflict",
      `Expected manifest revision ${expectedRevision}, found ${manifest.revision}.`,
    );
  }
}

export type MutationJournal = {
  vaultId: string;
  expectedRevision: number;
  operationId: string;
  phase: "candidate" | "proven" | "committed" | "aborted";
  candidateManifest?: RootProtectionManifest;
};

export function beginMutationJournal(input: {
  vaultId: string;
  expectedRevision: number;
  operationId: string;
}): MutationJournal {
  return {
    vaultId: input.vaultId,
    expectedRevision: input.expectedRevision,
    operationId: input.operationId,
    phase: "candidate",
  };
}

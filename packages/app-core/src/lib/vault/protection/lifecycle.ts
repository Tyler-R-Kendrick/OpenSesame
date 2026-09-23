/**
 * Last-verified-path guard and revision-checked mutation helpers (C08, KP-11).
 */

import { ProtectionError } from "./errors.js";
import type { ProtectionRecord, RootProtectionManifest } from "./types.js";

export function isVerifiedIndependentPath(record: ProtectionRecord): boolean {
  // Untested recovery grants (e.g. public age recipients) never count.
  return record.proofStatus === "verified";
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
      "Refusing to remove or replace the last verified independent unlock path.",
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

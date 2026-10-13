/** Enrollment journal and projection metadata only; no root, session guard or admission. */
import type {
  ProtectionRecord,
  RootProtectionManifest,
  VaultHeader,
} from "@opensesame/vault-core";
import type { provenEnrollmentRecord } from "./browser-enroll.js";
import type { LifecycleHost } from "./browser-lifecycle-ops.js";
import { reconcileLegacyRecords } from "./legacy-sync.js";
import type { MutationJournal } from "./lifecycle.js";
import type { manifestWithoutAuth } from "./manifest-auth.js";
type ManifestBody = ReturnType<typeof manifestWithoutAuth>;
export type EnrollCandidateResult = {
  operationId: string;
  expectedRevision: number;
  sessionGeneration: number;
  record: ProtectionRecord;
  /** Shown-once recovery secret; never persisted by the service. */
  recoverySecretB64?: string;
  /** Shown-once age identity; never persisted by the service. */
  ageIdentitySecret?: string;
};
export type PendingEnrollment = {
  operationId: string;
  sessionGeneration: number;
  expectedRevision: number;
  journal: MutationJournal;
  record: ProtectionRecord;
  recoverySecretB64?: string;
  baseManifest: RootProtectionManifest;
};
export function stageEnrollmentData(
  data: Readonly<{
    base: RootProtectionManifest;
    journal: MutationJournal;
    operationId: string;
    sessionGeneration: number;
    expectedRevision: number;
    built: Awaited<ReturnType<typeof provenEnrollmentRecord>>;
  }>,
) {
  const {
    base,
    journal,
    operationId,
    sessionGeneration,
    expectedRevision,
    built,
  } = data;
  journal.phase = "proven";
  journal.candidateManifest = {
    ...base,
    revision: expectedRevision + 1,
    records: [...base.records, built.record],
  };
  const pending: PendingEnrollment = {
    operationId,
    sessionGeneration,
    expectedRevision,
    journal,
    record: built.record,
    baseManifest: base,
  };
  if (built.recoverySecretB64 !== undefined)
    pending.recoverySecretB64 = built.recoverySecretB64;
  const result: EnrollCandidateResult = {
    operationId,
    expectedRevision,
    sessionGeneration,
    record: built.record,
  };
  if (built.recoverySecretB64 !== undefined)
    result.recoverySecretB64 = built.recoverySecretB64;
  if (built.ageIdentitySecret !== undefined)
    result.ageIdentitySecret = built.ageIdentitySecret;
  return { pending, result };
}
export function reconciledProjection(
  header: VaultHeader,
  manifest: RootProtectionManifest,
): ManifestBody | null {
  const records = reconcileLegacyRecords(header, manifest);
  if (!records) return null;
  const { authB64: _drop, preferredProtectorId, ...rest } = manifest;
  const body: ManifestBody = {
    ...rest,
    revision: manifest.revision + 1,
    records,
  };
  if (
    preferredProtectorId !== undefined &&
    records.some((record) => record.protectorId === preferredProtectorId)
  )
    body.preferredProtectorId = preferredProtectorId;
  return body;
}
export function committedEnrollmentBody(
  current: RootProtectionManifest,
  pending: PendingEnrollment,
): ManifestBody {
  const { authB64: _drop, ...rest } = current;
  return {
    ...rest,
    revision: pending.expectedRevision + 1,
    records: [...current.records, pending.record],
  };
}

/** Only private service callers supply this operation; this type creates no admission. */
export type LifecycleOperation<T> = (
  operations: typeof import("./browser-lifecycle-ops.js"),
  pinned: LifecycleHost & {
    withRootWriteTurn(work: () => Promise<void>): Promise<void>;
  },
) => Promise<T>;

/**
 * Restore boundary helpers (BACKUP-C/D): sync/login vs recovery paths.
 */

import {
  type DeviceRetirementRecord,
  type RestoreAttempt,
  type RestoreDecision,
  decideRestoreAttempt,
} from "../removal/device-retirement.js";
import {
  type AuthorityEpochs,
  type ImportDecision,
  type OfflineSnapshot,
  validateBackupImport,
} from "./import-guard.js";

export type RestoreBoundaryInput = Readonly<{
  retirement: DeviceRetirementRecord | null;
  attempt: RestoreAttempt;
  snapshot?: OfflineSnapshot;
  currentEpochs?: AuthorityEpochs;
  recoveryAuthorized?: boolean;
}>;

export type RestoreBoundaryResult = Readonly<{
  restore: RestoreDecision;
  importGate: ImportDecision | null;
}>;

/**
 * Compose retirement restore gate with backup epoch validation when a
 * snapshot is presented.
 */
export function evaluateRestoreBoundary(
  input: RestoreBoundaryInput,
): RestoreBoundaryResult {
  const restore = decideRestoreAttempt(input.retirement, input.attempt);
  if (!restore.allowed) {
    return { restore, importGate: null };
  }

  if (input.attempt.kind === "backup_import" && input.snapshot) {
    if (!input.currentEpochs) {
      return {
        restore: {
          allowed: false,
          code: "recovery_required",
          reason: "Backup import requires current authority epochs.",
        },
        importGate: null,
      };
    }
    const importGate = validateBackupImport({
      snapshot: input.snapshot,
      current: input.currentEpochs,
      deviceRetired: input.retirement !== null,
      recoveryAuthorized: input.recoveryAuthorized === true,
    });
    return { restore, importGate };
  }

  return { restore, importGate: null };
}

export {
  decideRestoreAttempt,
  retireDeviceBinding,
  clearDeviceRetirement,
} from "../removal/device-retirement.js";
export type {
  DeviceRetirementRecord,
  RestoreAttempt,
  RestoreDecision,
} from "../removal/device-retirement.js";

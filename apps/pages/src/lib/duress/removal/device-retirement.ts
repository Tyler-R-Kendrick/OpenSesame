/**
 * Device retirement control plane (BACKUP-B, BACKUP-C).
 * Retirement blocks new protected authority on this binding without
 * recovery/re-enrollment. It is not content deletion.
 */

import {
  type DeviceRetirementEvent,
  createDeviceRetirementEvent,
} from "./local-remove.js";

export type DeviceRetirementRecord = Readonly<{
  version: 1;
  deviceBindingRef: string;
  vaultRef: string;
  incidentId: string;
  retiredAt: string;
  event: DeviceRetirementEvent;
  /**
   * Sync/login auto-restore is refused until recovery clears this binding
   * or the owner re-enrolls (BACKUP-C).
   */
  autoRestoreAllowed: false;
  requires: "recovery_or_reenrollment";
}>;

export type RestoreAttempt =
  | { kind: "sync_pull"; deviceBindingRef: string; source: "cloud_sync" }
  | {
      kind: "login_restore";
      deviceBindingRef: string;
      source: "session_resume";
    }
  | {
      kind: "backup_import";
      deviceBindingRef: string;
      source: "offline_snapshot";
    }
  | {
      kind: "recovery_ceremony";
      deviceBindingRef: string;
      source: "authorized_recovery";
    }
  | {
      kind: "reenroll";
      deviceBindingRef: string;
      source: "owner_reenroll";
    };

export type RestoreDecision =
  | { allowed: true; reason: "not_retired" | "recovery_or_reenroll" }
  | {
      allowed: false;
      code: "retired_device" | "recovery_required";
      reason: string;
    };

/** Persistable retirement marker for this device binding. */
export function retireDeviceBinding(input: {
  deviceBindingRef: string;
  vaultRef: string;
  incidentId: string;
  retiredAt?: string;
}): DeviceRetirementRecord {
  const event = createDeviceRetirementEvent({
    deviceBindingRef: input.deviceBindingRef,
    vaultRef: input.vaultRef,
    incidentId: input.incidentId,
  });
  return {
    version: 1,
    deviceBindingRef: input.deviceBindingRef,
    vaultRef: input.vaultRef,
    incidentId: input.incidentId,
    retiredAt: input.retiredAt ?? new Date().toISOString(),
    event,
    autoRestoreAllowed: false,
    requires: "recovery_or_reenrollment",
  };
}

/**
 * Gate sync/login/backup restore against a retirement record (BACKUP-C).
 * Automatic paths fail closed; only recovery ceremony or re-enroll pass.
 */
export function decideRestoreAttempt(
  retirement: DeviceRetirementRecord | null,
  attempt: RestoreAttempt,
): RestoreDecision {
  if (!retirement) {
    return { allowed: true, reason: "not_retired" };
  }
  if (attempt.deviceBindingRef !== retirement.deviceBindingRef) {
    return { allowed: true, reason: "not_retired" };
  }
  if (attempt.kind === "recovery_ceremony" || attempt.kind === "reenroll") {
    return { allowed: true, reason: "recovery_or_reenroll" };
  }
  return {
    allowed: false,
    code:
      attempt.kind === "backup_import" ? "recovery_required" : "retired_device",
    reason:
      "Retired device binding refuses automatic sync/login/snapshot restore without recovery or re-enrollment.",
  };
}

/** Clear retirement only after authorized recovery/re-enrollment. */
export function clearDeviceRetirement(
  retirement: DeviceRetirementRecord,
  proof: { kind: "recovery_ceremony" | "reenroll"; authorized: boolean },
): DeviceRetirementRecord | null {
  if (!proof.authorized) {
    throw new Error("recovery_required");
  }
  if (proof.kind !== "recovery_ceremony" && proof.kind !== "reenroll") {
    throw new Error("recovery_required");
  }
  void retirement;
  return null;
}

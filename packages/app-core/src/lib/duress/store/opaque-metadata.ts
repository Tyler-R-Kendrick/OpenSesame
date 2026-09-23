/**
 * Opaque pre-unlock metadata vs post-unlock settings boundary (STORE-D).
 * Activation, cleanup markers, and alert enqueue must not require the protected root.
 */

import {
  type IncidentIntent,
  loadIncidentIntent,
} from "../incident/intent-journal.js";
import { readOpaqueEnrollmentMetadata } from "./enrollment-publication.js";

export type PreUnlockDuressView = Readonly<{
  enrolled: boolean;
  armed: boolean;
  slotCount: number;
  policyRevision: number | null;
  activeIncident: boolean;
  incidentId: string | null;
  presentationHint:
    | "normal"
    | "restricted"
    | "decoy"
    | "locked"
    | "unchanged"
    | null;
}>;

export type PostUnlockSettingsGate = Readonly<{
  unlocked: boolean;
  mayReadProtectedSettings: boolean;
  mayMutateEnrollment: boolean;
}>;

/** Safe before any vault unwrap — digests and flags only. */
export function preUnlockDuressView(): PreUnlockDuressView {
  const opaque = readOpaqueEnrollmentMetadata();
  const intent = loadIncidentIntent();
  return {
    enrolled: opaque !== null,
    armed: opaque?.armed ?? false,
    slotCount: opaque?.slotCount ?? 0,
    policyRevision: opaque?.policyRevision ?? null,
    activeIncident: intent?.state === "active",
    incidentId: intent?.incidentId ?? null,
    presentationHint: intent?.presentation ?? null,
  };
}

export function postUnlockSettingsGate(
  unlocked: boolean,
): PostUnlockSettingsGate {
  return {
    unlocked,
    mayReadProtectedSettings: unlocked,
    mayMutateEnrollment: unlocked,
  };
}

/**
 * Whether alert/cleanup side-effects may run without the protected root.
 * Requires only opaque enrollment + durable incident intent.
 */
export function canRunRootlessEffects(intent: IncidentIntent | null): boolean {
  if (!intent) return false;
  return intent.state === "active" || intent.state === "recovery_requested";
}

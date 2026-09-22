/**
 * Domain mirror of duress semantic types.
 * Wire authority: `@opensesame/contracts` Zod schemas under `duress/`.
 */

export type DuressRef = string;
export type DuressRevision = number;

export type ScopeBinding = Readonly<{
  ownerPrincipalRef: DuressRef;
  organizationRef: DuressRef | null;
  vaultRef: DuressRef;
  deviceBindingRef: DuressRef;
  compartmentRefs: readonly DuressRef[];
}>;

export type PresentationClass =
  | "normal"
  | "restricted"
  | "decoy"
  | "locked"
  | "unchanged";

export type TriggerKind =
  | "application_code"
  | "verified_uv_then_code"
  | "prf_and_code"
  | "canary_activation"
  | "delegated_peer_request"
  | "approval_ceremony_code";

export type DuressAssuranceLevel =
  | "unavailable"
  | "unsupported"
  | "configured"
  | "verified_ready";

export type IncidentState =
  | "active"
  | "recovery_requested"
  | "resolved"
  | "superseded";

export type EffectStatus =
  | "not_requested"
  | "pending"
  | "applied_local"
  | "accepted_remote"
  | "confirmed_remote"
  | "failed"
  | "expired"
  | "completion_unknown";

export type CompilerErrorCode =
  | "scope_mismatch"
  | "ambiguous_trigger"
  | "independent_keys_required"
  | "unsupported_factor"
  | "alternate_unlock_bypass"
  | "circular_recovery"
  | "unavailable_authority"
  | "undurable_storage"
  | "contradictory_actions"
  | "unapproved_route"
  | "stale_policy"
  | "stale_session"
  | "retired_device"
  | "unsupported_profile_version"
  | "recovery_required";

export const SCENARIO_IDS = [
  "SC-ALERT-ONLY",
  "SC-RESTRICTED",
  "SC-DECOY",
  "SC-LOCAL-HOLD",
  "SC-CUSTODIAN-HOLD",
  "SC-QUARANTINE",
  "SC-LOCAL-REMOVE",
  "SC-LIMITED-CARRY",
  "SC-APPROVAL-DURESS",
  "SC-LOST-DEVICE",
  "SC-SPLIT-SCOPE",
  "SC-CANARY",
  "SC-REHEARSAL",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

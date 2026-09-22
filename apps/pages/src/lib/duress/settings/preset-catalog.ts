/**
 * Curated duress presets — catalog labels only.
 * Security decisions come from CONTRACT compileDuressPolicy; presets do not
 * re-implement compiler rules.
 */

import type { PolicyDocument, PolicyProfile } from "@opensesame/contracts";
import { SCENARIO_IDS, type ScenarioId } from "@opensesame/contracts";
import { includesStringLiteral } from "../json-boundary.js";

/** Preset IDs are the CONTRACT scenario catalog — do not mirror locally. */
export const PRESET_IDS = SCENARIO_IDS;
export type PresetId = ScenarioId;

export type PresetMeta = Readonly<{
  id: PresetId;
  /** Display title (alias of label for panel consumers). */
  title: string;
  label: string;
  summary: string;
  honestLimit: string;
  requiresDestructiveAck: boolean;
  requiresRecipient: boolean;
  requiresCustodian: boolean;
}>;

export const PRESET_CATALOG: readonly PresetMeta[] = [
  {
    id: "SC-ALERT-ONLY",
    title: "Alert only",
    label: "Alert only",
    summary:
      "Queues a sealed alert; unlock may stay real-access if configured.",
    honestLimit:
      "Alert queued ≠ delivered ≠ acknowledged; no emergency response.",
    requiresDestructiveAck: false,
    requiresRecipient: true,
    requiresCustodian: false,
  },
  {
    id: "SC-RESTRICTED",
    title: "Restricted",
    label: "Restricted",
    summary:
      "Presentation and access ceiling limited to admitted compartments.",
    honestLimit: "Shared-root projects are not isolated.",
    requiresDestructiveAck: false,
    requiresRecipient: false,
    requiresCustodian: false,
  },
  {
    id: "SC-DECOY",
    title: "Decoy",
    label: "Decoy",
    summary: "Shows an independently keyed decoy compartment.",
    honestLimit:
      "Decoy never forges production success or mutates real providers.",
    requiresDestructiveAck: false,
    requiresRecipient: false,
    requiresCustodian: false,
  },
  {
    id: "SC-LOCAL-HOLD",
    title: "Local hold",
    label: "Local hold",
    summary:
      "Ordinary-looking locked/unavailable; sensitive handles invalidated.",
    honestLimit:
      "No countdown UI; local clock is not a tamper clock; expiry ≠ auto-unlock.",
    requiresDestructiveAck: true,
    requiresRecipient: false,
    requiresCustodian: false,
  },
  {
    id: "SC-CUSTODIAN-HOLD",
    title: "Custodian hold",
    label: "Custodian hold",
    summary: "Selected compartments need recovery contributions.",
    honestLimit: "Approval quorum ≠ key custody; disclose historical keys.",
    requiresDestructiveAck: true,
    requiresRecipient: false,
    requiresCustodian: true,
  },
  {
    id: "SC-QUARANTINE",
    title: "Quarantine",
    label: "Quarantine",
    summary: "Keep a small local compartment; quarantine peer refs.",
    honestLimit: "Network reachability alone is not authority.",
    requiresDestructiveAck: false,
    requiresRecipient: false,
    requiresCustodian: false,
  },
  {
    id: "SC-LOCAL-REMOVE",
    title: "Local remove",
    label: "Local remove",
    summary:
      "Enumerated local resources removed; optional sealed outbox retained.",
    honestLimit: "Not global wipe; not forensic erasure.",
    requiresDestructiveAck: true,
    requiresRecipient: false,
    requiresCustodian: false,
  },
  {
    id: "SC-LIMITED-CARRY",
    title: "Limited carry",
    label: "Limited carry",
    summary: "Retain selected everyday items under a ceiling.",
    honestLimit: "Explicit pre-incident consent required.",
    requiresDestructiveAck: false,
    requiresRecipient: false,
    requiresCustodian: false,
  },
  {
    id: "SC-APPROVAL-DURESS",
    title: "Approval duress",
    label: "Approval duress",
    summary: "Deny before sign/mint/invoke in an app-owned approval ceremony.",
    honestLimit: "No fake success; agents cannot approve.",
    requiresDestructiveAck: false,
    requiresRecipient: false,
    requiresCustodian: false,
  },
  {
    id: "SC-LOST-DEVICE",
    title: "Lost device",
    label: "Lost device",
    summary: "Local retirement / quarantine path via delegated peer request.",
    honestLimit: "Peer must present bound delegation, not network presence.",
    requiresDestructiveAck: false,
    requiresRecipient: false,
    requiresCustodian: false,
  },
  {
    id: "SC-SPLIT-SCOPE",
    title: "Split scope",
    label: "Split scope",
    summary: "Personal vs org compartments differ per-owner profiles.",
    honestLimit: "Scope expansion requires each affected owner.",
    requiresDestructiveAck: false,
    requiresRecipient: false,
    requiresCustodian: false,
  },
  {
    id: "SC-CANARY",
    title: "Canary",
    label: "Canary",
    summary: "Detection-only canary activation.",
    honestLimit: "Never escalates to destruction from hits alone.",
    requiresDestructiveAck: false,
    requiresRecipient: true,
    requiresCustodian: false,
  },
  {
    id: "SC-REHEARSAL",
    title: "Rehearsal",
    label: "Rehearsal",
    summary:
      "Isolated exercise proving readiness without arming production effects.",
    honestLimit:
      "Required before arming; never leaves half-armed destructive codes.",
    requiresDestructiveAck: false,
    requiresRecipient: false,
    requiresCustodian: false,
  },
] as const;

export type PresetScope = Readonly<{
  ownerPrincipalRef: string;
  organizationRef: string | null;
  vaultRef: string;
  deviceBindingRef: string;
  compartmentRefs: readonly string[];
  presentationCompartmentRef?: string;
  alertRouteRef?: string;
  alertTemplateRef?: string;
  recoveryPolicyRef?: string;
  operationCeilingRef?: string;
  peerRef?: string;
  removalResourceRefs?: readonly string[];
  authorityRef?: string;
}>;

export function isPresetId(value: string): value is PresetId {
  return includesStringLiteral(PRESET_IDS, value);
}

export function getPresetMeta(id: PresetId): PresetMeta {
  const meta = PRESET_CATALOG.find((p) => p.id === id);
  if (!meta) throw new Error(`unknown_preset:${id}`);
  return meta;
}

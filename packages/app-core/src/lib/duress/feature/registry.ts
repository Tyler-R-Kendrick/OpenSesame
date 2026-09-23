/**
 * Duress capability catalog (capability-registry pattern, ADR 0065 / 0130).
 * Modes gate which surfaces may be dynamically imported. Off ⇒ empty load set.
 */

import type { DuressFeatureMode } from "./types.js";

export type DuressCapabilityId =
  | "duress.access"
  | "duress.session"
  | "duress.crypto"
  | "duress.trigger"
  | "duress.alert"
  | "duress.incident"
  | "duress.store"
  | "duress.settings"
  | "duress.compartment"
  | "duress.recovery"
  | "duress.removal"
  | "duress.canary"
  | "duress.peer"
  | "duress.ui";

export type DuressCapability = Readonly<{
  id: DuressCapabilityId;
  title: string;
  /** Import specifier relative to packages/app-core/src/lib/duress/. */
  modulePath: string;
  /** Modes that may fetch this module. Never includes "off". */
  modes: readonly Exclude<DuressFeatureMode, "off">[];
  kind: "core" | "optional_network" | "ui";
  /** Honest label when withheld from a mode. */
  unsupportedReason?: string;
}>;

/**
 * Literal catalog — parity with packages/capability-registry: one list maps id →
 * surface path. Verify scripts assert off builds do not import UI or peer adapters.
 */
export const DURESS_CAPABILITIES: readonly DuressCapability[] = [
  {
    id: "duress.access",
    title: "Opaque access context",
    modulePath: "access/context.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.session",
    title: "Session fence",
    modulePath: "session/fence.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.crypto",
    title: "Compartment key slots",
    modulePath: "crypto/slots.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.trigger",
    title: "Trigger enrollment/select",
    modulePath: "trigger/enrollment.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.alert",
    title: "Sealed alert outbox",
    modulePath: "alert/outbox.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.incident",
    title: "Incident activation",
    modulePath: "incident/activate.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.store",
    title: "Compartment store guard",
    modulePath: "store/compartment-guard.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.settings",
    title: "Arming / dry-run",
    modulePath: "settings/arming.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.compartment",
    title: "Presentation projection",
    modulePath: "compartment/project.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.recovery",
    title: "Recovery custody",
    modulePath: "recovery/custody.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.removal",
    title: "Scoped local removal",
    modulePath: "removal/local-remove.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.canary",
    title: "Canary detection",
    modulePath: "canary/detect.js",
    modes: ["local_only", "optional_peer"],
    kind: "core",
  },
  {
    id: "duress.peer",
    title: "Optional peer envelopes",
    modulePath: "peer/envelope.js",
    modes: ["optional_peer"],
    kind: "optional_network",
    unsupportedReason:
      "Peer channel requires optional_peer mode; local_only labels peer unsupported",
  },
  {
    id: "duress.ui",
    title: "Duress settings UI",
    modulePath: "../../components/duress/DuressSettingsPanel.js",
    modes: ["local_only", "optional_peer"],
    kind: "ui",
  },
] as const;

export function capabilitiesForMode(
  mode: DuressFeatureMode,
): readonly DuressCapability[] {
  if (mode === "off") return [];
  return DURESS_CAPABILITIES.filter((c) => c.modes.includes(mode));
}

export function capabilityIdsForMode(
  mode: DuressFeatureMode,
): readonly string[] {
  return capabilitiesForMode(mode).map((c) => c.id);
}

/** Capabilities withheld from a mode (honest unsupported, never stubbed). */
export function unsupportedCapabilitiesForMode(
  mode: DuressFeatureMode,
): readonly DuressCapability[] {
  if (mode === "off") return [...DURESS_CAPABILITIES];
  return DURESS_CAPABILITIES.filter((c) => !c.modes.includes(mode));
}

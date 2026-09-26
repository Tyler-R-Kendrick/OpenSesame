/**
 * Features — the sections Settings › Capabilities draws, one list.
 *
 * The catalog is granular on purpose: a consent receipt binds one
 * descriptor's exposure, and an operator's policy may name any single id.
 * Nobody decides "SIOP, but not the site broker" while using the app,
 * though. A feature is a section of the page: a topic, the connector
 * families (the Connections catalogue's categories) whose providers are
 * configured under it, and the optional capabilities — if any — its one
 * switch adds and removes. A feature with no optional capability is a
 * function every installation has; its section draws the same way and
 * simply carries no switch (ADR 0142).
 *
 * Every optional capability has exactly one home, and so does every
 * connector family: two sections never configure the same thing.
 *
 * Pure data and pure functions: no store, no React, no network.
 */

import type {
  CapabilityCatalog,
  CapabilityId,
  EffectivePlan,
} from "@opensesame/capability-composition";
import type { ProviderCategory } from "../connections.js";

export type FeatureId =
  | "identity"
  | "directory"
  | "encryption"
  | "certificates"
  | "backups"
  | "password-managers"
  | "cloud-secret-storage"
  | "local-storage"
  | "sharing"
  | "payments"
  | "ai"
  | "networking"
  | "notifications"
  | "telemetry";

export type Feature = Readonly<{
  id: FeatureId;
  title: string;
  /**
   * Optional capabilities the section's switch adds and removes, in catalog
   * order. Empty: an always-on function, drawn with no switch.
   */
  capabilities: readonly CapabilityId[];
  /** Connector families configured in this section. */
  providerCategories: readonly ProviderCategory[];
  /** The model picks (voice and inference) sit in this section. */
  models?: true;
  /**
   * The always-on capabilities this section's providers work through. An
   * operator may withdraw one (ADR 0142); the section then says so.
   */
  backedBy?: readonly CapabilityId[];
}>;

const section = (
  id: FeatureId,
  title: string,
  capabilities: readonly CapabilityId[],
  providerCategories: readonly ProviderCategory[],
  backedBy: readonly CapabilityId[] = [],
): Feature => ({ id, title, capabilities, providerCategories, backedBy });

/**
 * In page order, by topic: who signs in, what protects keys, where secrets
 * live, then what this installation does with others and with models.
 * Browser-local IAM, SIOP, the site broker and git backup are always on
 * (ADR 0142), so Identity providers and Backups carry no switch.
 */
export const FEATURES: readonly Feature[] = [
  section(
    "identity",
    "Identity providers",
    [],
    ["identity"],
    ["identity.federation"],
  ),
  section("directory", "Directory", ["enterprise.directory-provisioning"], []),
  section(
    "encryption",
    "Encryption",
    [],
    ["encryption"],
    ["backup.cloud-secrets"],
  ),
  section(
    "certificates",
    "Certificate authority",
    ["enterprise.ca-administration"],
    ["certificates"],
  ),
  section("backups", "Backups", [], ["backup_recovery"], ["backup.git-remote"]),
  section(
    "password-managers",
    "Password managers",
    [],
    ["password_managers"],
    ["connectors.external"],
  ),
  section(
    "cloud-secret-storage",
    "Cloud secret storage",
    [],
    ["cloud_secret_storage"],
    ["connectors.external"],
  ),
  section(
    "local-storage",
    "Local storage",
    [],
    ["local_storage"],
    ["connectors.external"],
  ),
  section("sharing", "Sharing", ["sharing.drops", "sharing.household"], []),
  section("payments", "Payments", ["wallet.spending"], ["wallet"]),
  {
    ...section(
      "ai",
      "AI",
      ["support.local-ai", "support.remote-ai", "agents.webmcp"],
      ["agent_harnesses"],
    ),
    models: true,
  },
  section("networking", "Networking", ["networking.tailnet"], ["networking"]),
  section(
    "notifications",
    "Notifications",
    ["notifications.web-push", "notifications.routing"],
    [],
  ),
  section("telemetry", "Telemetry", ["telemetry.external"], []),
];

/** Whether a section carries a switch: it has an optional capability. */
export function isSwitchable(feature: Feature): boolean {
  return feature.capabilities.length > 0;
}

export function featureById(id: FeatureId): Feature {
  const feature = FEATURES.find((entry) => entry.id === id);
  if (!feature) throw new Error(`unknown feature ${id}`);
  return feature;
}

/** The feature a capability rolls up into, or `null` for an always-on one. */
export function featureOf(id: CapabilityId): Feature | null {
  return FEATURES.find((entry) => entry.capabilities.includes(id)) ?? null;
}

export type FeatureState = Readonly<{
  /** Any of its capabilities is approved in this plan. */
  on: boolean;
  /** Every capability it could run here is approved. */
  complete: boolean;
  /** Its capabilities this plan distributes and permits. */
  available: readonly CapabilityId[];
  approved: readonly CapabilityId[];
}>;

export function featureState(
  feature: Feature,
  plan: EffectivePlan | null,
): FeatureState {
  const available = feature.capabilities.filter((id) => {
    const state = plan?.capabilities[id];
    return state?.distributed === true && state.permitted;
  });
  const approved = feature.capabilities.filter(
    (id) => plan?.capabilities[id]?.approved === true,
  );
  return {
    on: approved.length > 0,
    complete: available.every((id) => approved.includes(id)),
    available,
    approved,
  };
}

export type FeatureProposal = Readonly<{
  roots: readonly CapabilityId[];
  /** Alternative choices by slot: what was chosen, plus any the switch had to make. */
  alternatives: Readonly<Record<string, CapabilityId>>;
}>;

/**
 * What the installation's selection becomes when a feature is switched.
 *
 * On adds every capability of the feature this plan can run; off removes
 * every one of them, and the alternative choices they made. Roots that are not optional in the catalog — an id a
 * selection recorded before it became always-on — are dropped, since a
 * selection never names core. A capability that needs a choice for one of
 * its alternative slots gets one: a peer the same switch adds if there is
 * one (Sharing's household transport is Sharing's own drops), else the
 * first option this plan can run. One switch never leaves a review blocked
 * on a question the person was not asked.
 */
export function switchFeature(
  current: FeatureProposal,
  feature: Feature,
  on: boolean,
  plan: EffectivePlan | null,
  catalog: CapabilityCatalog,
): FeatureProposal {
  const optional = new Set(
    catalog.capabilities
      .filter((entry) => entry.tier === "optional")
      .map((entry) => entry.id),
  );
  const kept = current.roots.filter(
    (id) => optional.has(id) && !feature.capabilities.includes(id),
  );
  if (!on) {
    // Forget the choices this feature's capabilities made, so adding one of
    // them again later asks the question again instead of reusing an answer
    // — unless a root that stays still answers to the same slot.
    const slotsOf = (ids: readonly CapabilityId[]) =>
      new Set(
        catalog.capabilities
          .filter((entry) => ids.includes(entry.id))
          .flatMap((entry) => entry.alternatives.map((slot) => slot.slot)),
      );
    const stillNeeded = slotsOf(kept);
    const slots = new Set(
      [...slotsOf(feature.capabilities)].filter(
        (slot) => !stillNeeded.has(slot),
      ),
    );
    const alternatives = Object.fromEntries(
      Object.entries(current.alternatives).filter(([slot]) => !slots.has(slot)),
    );
    return { roots: kept, alternatives };
  }
  const added = featureState(feature, plan).available;
  const alternatives = { ...current.alternatives };
  const runnable = (id: CapabilityId) => {
    const state = plan?.capabilities[id];
    return state === undefined || (state.distributed && state.permitted);
  };
  for (const id of added) {
    const descriptor = catalog.capabilities.find((entry) => entry.id === id);
    for (const slot of descriptor?.alternatives ?? []) {
      if (alternatives[slot.slot] !== undefined) continue;
      const pick =
        slot.oneOf.find((option) => added.includes(option)) ??
        slot.oneOf.find(runnable);
      if (pick !== undefined) alternatives[slot.slot] = pick;
    }
  }
  return { roots: [...kept, ...added], alternatives };
}

/**
 * One capability of a section switched on its own — a tile inside a
 * section with more than one. The same proposal as the section's switch,
 * narrowed to that capability, so an alternative slot it needs is still
 * answered and switching it off still forgets the choice it made.
 */
export function switchCapability(
  current: FeatureProposal,
  feature: Feature,
  id: CapabilityId,
  on: boolean,
  plan: EffectivePlan | null,
  catalog: CapabilityCatalog,
): FeatureProposal {
  return switchFeature(
    current,
    { ...feature, capabilities: [id] },
    on,
    plan,
    catalog,
  );
}

/**
 * The kept roots that answer an alternative slot with `id` — Household
 * sharing's transport is Shared drops. Switching `id` off on its own would
 * leave a review that changes nothing (the slot keeps it), so its tile says
 * who needs it instead of offering a switch that cannot take.
 */
export function neededBy(
  current: FeatureProposal,
  id: CapabilityId,
  catalog: CapabilityCatalog,
): CapabilityId[] {
  const slots = Object.entries(current.alternatives)
    .filter(([, chosen]) => chosen === id)
    .map(([slot]) => slot);
  if (slots.length === 0) return [];
  return current.roots.filter(
    (root) =>
      root !== id &&
      catalog.capabilities
        .find((entry) => entry.id === root)
        ?.alternatives.some((slot) => slots.includes(slot.slot)) === true,
  );
}

/**
 * Always-on capabilities this plan does not run: an operator withdrew them
 * (ADR 0142), or they need one that was. The page names them rather than
 * drawing their sections as though they ran.
 */
export function withdrawnAlwaysOn(plan: EffectivePlan | null): CapabilityId[] {
  if (plan === null) return [];
  return Object.values(plan.capabilities)
    .filter((state) => state.tier === "core" && !state.approved)
    .map((state) => state.id)
    .sort();
}

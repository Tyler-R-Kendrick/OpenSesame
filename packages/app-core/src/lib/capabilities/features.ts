/**
 * Features — the switches a person or operator actually thinks in.
 *
 * The catalog is granular on purpose: a consent receipt binds one
 * descriptor's exposure, and an operator's policy may name any single id.
 * Nobody decides "SIOP, but not the site broker" while using the app,
 * though. A feature is a rollup: one switch over the optional capabilities
 * that make up a way of using OpenSesame, together with the connector
 * families (the Connections catalogue's categories) whose providers that
 * feature binds to. Settings › Capabilities draws one row per feature, and
 * the per-capability rows only under Advanced.
 *
 * `PROVIDER_GROUPS` are the connector families of always-on functions —
 * identity providers, encryption, password managers and the rest. They have
 * no switch, because nothing about them can be switched off, but their
 * providers are configured on the same page.
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
  | "ai"
  | "backups"
  | "payments"
  | "servers"
  | "sharing"
  | "networking"
  | "notifications"
  | "telemetry";

export type Feature = Readonly<{
  id: FeatureId;
  title: string;
  /** Optional capabilities the switch adds and removes, in catalog order. */
  capabilities: readonly CapabilityId[];
  /** Connector families configured under this feature while it is on. */
  providerCategories: readonly ProviderCategory[];
  /** The model picks (voice and inference) sit under this feature. */
  models?: true;
}>;

export const FEATURES: readonly Feature[] = [
  {
    id: "ai",
    title: "AI",
    capabilities: ["support.local-ai", "support.remote-ai", "agents.webmcp"],
    providerCategories: ["agent_harnesses"],
    models: true,
  },
  {
    id: "backups",
    title: "Backups",
    capabilities: ["backup.git-remote"],
    providerCategories: ["backup_recovery"],
  },
  {
    id: "payments",
    title: "Payments",
    capabilities: ["wallet.spending"],
    providerCategories: ["wallet"],
  },
  {
    id: "servers",
    title: "Servers",
    capabilities: [
      "identity.local-iam",
      "identity.siop",
      "identity.site-broker",
      "enterprise.directory-provisioning",
      "enterprise.ca-administration",
    ],
    providerCategories: ["certificates"],
  },
  {
    id: "sharing",
    title: "Sharing",
    capabilities: ["sharing.drops", "sharing.household"],
    providerCategories: [],
  },
  {
    id: "networking",
    title: "Networking",
    capabilities: ["networking.tailnet"],
    providerCategories: ["networking"],
  },
  {
    id: "notifications",
    title: "Notifications",
    capabilities: ["notifications.web-push"],
    providerCategories: [],
  },
  {
    id: "telemetry",
    title: "Telemetry",
    capabilities: ["telemetry.external"],
    providerCategories: [],
  },
];

export type ProviderGroup = Readonly<{
  category: ProviderCategory;
  title: string;
}>;

/** Connector families of always-on functions: configured, never switched. */
export const PROVIDER_GROUPS: readonly ProviderGroup[] = [
  { category: "identity", title: "Identity providers" },
  { category: "encryption", title: "Encryption" },
  { category: "password_managers", title: "Password managers" },
  { category: "cloud_secret_storage", title: "Cloud secret storage" },
  { category: "local_storage", title: "Local storage" },
];

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
  const alternatives: Record<string, CapabilityId> = {
    ...current.alternatives,
  };
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

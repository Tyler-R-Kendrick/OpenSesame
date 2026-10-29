/**
 * Features — the sections Settings › Features draws, one list of switches.
 *
 * The catalog is granular on purpose: a consent receipt binds one
 * descriptor's exposure, and an operator's policy may name any single id.
 * Nobody decides "SIOP, but not the site broker" while using the app,
 * though. A feature is a section of the page: a topic and the optional
 * capabilities its one switch adds and removes — the feature flags of this
 * installation, each through a reviewed plan and a consent receipt (ADR 0130).
 *
 * What a feature connects to — a third party's service that extends or
 * replaces it — is an integration (`integrations.ts`, ADR 0189), configured
 * by reference on its own page. Every optional capability has exactly one
 * home here, and every connector family exactly one there: the two lists
 * share no field, so a section can never be both.
 *
 * Pure data and pure functions: no store, no React, no network.
 */

import type {
  CapabilityCatalog,
  CapabilityId,
  EffectivePlan,
} from "@opensesame/capability-composition";
import { type SurfaceContext, shown } from "./feature-surface.js";

export {
  NEEDS_IDENTITY_API,
  NO_SURFACE,
  type SurfaceContext,
  dependentsOf,
  heldOutside,
  shown,
} from "./feature-surface.js";

export type FeatureId =
  | "identity"
  | "access"
  | "connections"
  | "item-types"
  | "environments"
  | "security-checks"
  | "directory"
  | "certificates"
  | "encrypted-search"
  | "autofill"
  | "sharing"
  | "payments"
  | "ai"
  | "password-reset"
  | "surrogates"
  | "networking"
  | "local-notifications"
  | "notifications"
  | "telemetry";

export type Feature = Readonly<{
  id: FeatureId;
  title: string;
  /**
   * Optional capabilities the section's switch adds and removes, in catalog
   * order. `shown` may leave none (a capability with no surface here); the
   * section is then not drawn.
   */
  capabilities: readonly CapabilityId[];
  /**
   * The always-on capabilities this section's optional ones work through. An
   * operator may withdraw one (ADR 0142); the section then says so.
   */
  backedBy?: readonly CapabilityId[];
}>;

const section = (
  id: FeatureId,
  title: string,
  capabilities: readonly CapabilityId[],
  backedBy: readonly CapabilityId[] = [],
): Feature => ({ id, title, capabilities, backedBy });

/**
 * In page order, by topic: who signs in, who may do what, what the vault
 * holds, then what this installation does with others and with models. A
 * feature is a flag to switch (though Certificate authority and Telemetry
 * draw one only while a plan approves them, `NO_SURFACE`): the site broker and git backup are
 * always on (ADR 0142), so they are not here — their providers are
 * integrations. Identity, Connections, Access and item types are optional
 * extensions (ADR 0153): off until their switch is on.
 */
export const FEATURES: readonly Feature[] = [
  section("identity", "Identity", [
    "identity.local-iam",
    "identity.siop",
    "identity.federation",
    "identity.ambient-sso",
  ]),
  section("access", "Access", ["access.authority"]),
  section("connections", "Connections", ["connectors.external"]),
  section("directory", "Directory", ["enterprise.directory-provisioning"]),
  section("certificates", "Certificate authority", [
    "enterprise.ca-administration",
  ]),
  section("encrypted-search", "Encrypted search", ["storage.encrypted-search"]),
  section("item-types", "Item types", [
    "vault.derived-records",
    "vault.passkey-records",
    "vault.certificate-records",
  ]),
  section("environments", "Environments", ["vault.environments"]),
  section("security-checks", "Breach checks", ["vault.security-checks"]),
  // Runtime-installed plugins (ADR 0150 §7): advanced, default off, and
  // nothing of the plugin itself is in the bundle — the section shows what
  // the paired daemon has installed and switches it there.
  section("autofill", "Browser autofill", ["vault.browser-autofill"]),
  section(
    "sharing",
    "Sharing",
    [
      "sharing.live",
      "sharing.household",
      "sharing.trusted-contacts",
      "sharing.relay",
    ],
    ["sharing.drops"],
  ),
  section("payments", "Payments", ["wallet.spending"]),
  section("ai", "AI", [
    "support.local-ai",
    "support.remote-ai",
    "agents.webmcp",
  ]),
  section("password-reset", "Password reset", ["ai.password-reset"]),
  section("surrogates", "Surrogate credentials", [
    "agents.surrogate-credentials",
  ]),
  section("networking", "Networking", [
    "networking.tailnet",
    "networking.tailnet-devices",
  ]),
  // Told on this device, with no service: its own section, because it needs
  // none of the Identity API the section below is for (ADR 0162).
  section("local-notifications", "Local notifications", [
    "notifications.local",
  ]),
  section("notifications", "Notifications", [
    "notifications.web-push",
    "notifications.routing",
  ]),
  section("telemetry", "Telemetry", ["telemetry.external"]),
];

/** Whether a section carries a switch: it has a surface capability that is active or available to activate. */
export function isSwitchable(
  feature: Feature,
  plan: EffectivePlan | null = null,
  context?: SurfaceContext,
): boolean {
  const visible = shown(feature, plan, context);
  if (plan === null) return visible.capabilities.length > 0;
  const state = featureState(visible, plan);
  return (
    state.approved.length > 0 ||
    state.available.length > 0 ||
    visible.capabilities.some((id) => plan.capabilities[id] === undefined)
  );
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
  let added = featureState(feature, plan).available;
  // The Identity section switch (`switchFeature` on the full feature). A
  // single-capability toggle (`switchCapability`) passes a one-id feature and
  // must still be able to add Self-issued OpenID on its own.
  if (feature.id === "identity" && on && feature.capabilities.length > 1) {
    const skip = new Set<CapabilityId>([
      "identity.siop",
      "identity.ambient-sso",
    ]);
    added = added.filter((id) => !skip.has(id));
  }
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

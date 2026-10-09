/**
 * What Settings draws of a feature, and which running capabilities hold which
 * others up: pure helpers over the feature list and a plan (ADR 0158).
 */

import type {
  CapabilityId,
  EffectivePlan,
} from "@opensesame/capability-composition";
import type { Feature } from "./features.js";

/**
 * Optional capabilities with no Pages code behind them. Each exists so an
 * operator can name it in a policy — prohibit it, or leave it out of a
 * distribution — and its module registers nothing: External telemetry has no
 * collector, Certificate authority no Host issuance surface, and Household
 * sharing no members or share action (`modules/<id>/runtime.ts` say so). A
 * switch for one changes nothing a person can see, so Settings draws none
 * (ADR 0158).
 */
export const NO_SURFACE: ReadonlySet<CapabilityId> = new Set([
  "telemetry.external",
  "enterprise.ca-administration",
  "sharing.household",
]);

/**
 * Optional capabilities whose every road is an Identity API's: Web Push
 * enrols with one and Notification routing reads and writes one. With none
 * named, a switch for either changes nothing a person can see, and its tile
 * would describe a service that is not there. So with no Identity API Settings
 * draws neither (ADR 0158, ADR 0162), unless the plan already approves it:
 * the same rule as `NO_SURFACE`, decided by what is configured rather than by
 * what is built.
 */
export const NEEDS_IDENTITY_API: ReadonlySet<CapabilityId> = new Set([
  "notifications.web-push",
  "notifications.routing",
]);

/** What this installation has that decides what Settings can draw. */
export type SurfaceContext = Readonly<{
  /** An Identity API is named in Settings. */
  identityApi: boolean;
}>;

/** Without being told otherwise, nothing is withheld for want of a service. */
const SERVICE_NAMED: SurfaceContext = { identityApi: true };

/**
 * The feature as Settings draws it: the capabilities a switch can change. A
 * capability with no surface is left out unless the plan already approves it —
 * a persisted selection or a policy can carry one, and others run on it
 * (Certificate authority on Access and Certificate records), so its owner keeps
 * the one switch that turns it off (ADR 0158: a row acts, and a setting is not
 * removable while something depends on it, nor stranded). So is one whose only
 * road is a service that is not named (`NEEDS_IDENTITY_API`).
 */
export function shown(
  feature: Feature,
  plan: EffectivePlan | null = null,
  context: SurfaceContext = SERVICE_NAMED,
): Feature {
  const hidden = (id: CapabilityId) =>
    (NO_SURFACE.has(id) ||
      (!context.identityApi && NEEDS_IDENTITY_API.has(id))) &&
    plan?.capabilities[id]?.approved !== true;
  return feature.capabilities.some(hidden)
    ? {
        ...feature,
        capabilities: feature.capabilities.filter((id) => !hidden(id)),
      }
    : feature;
}

/**
 * The approved capabilities that run on `id`: Self-issued OpenID is built on
 * Browser-local IAM, so while it runs the plan pulls IAM back in as its
 * dependency. Switching IAM off on its own would review a change that
 * changes nothing, so its tile says who needs it instead of offering a
 * switch that cannot take (ADR 0158 §3).
 */
export function dependentsOf(
  plan: EffectivePlan | null,
  id: CapabilityId,
): CapabilityId[] {
  const state = plan?.capabilities[id];
  if (!state) return [];
  return state.dependencyOf.filter(
    (dependent) => plan?.capabilities[dependent]?.approved === true,
  );
}

/**
 * The running capabilities outside `feature` that run on one of its own: the
 * section's switch would leave those behind, so it is not drawn while any
 * stand (Certificate authority runs on Access and on Passkey records).
 */
export function heldOutside(
  plan: EffectivePlan | null,
  feature: Pick<Feature, "capabilities">,
): CapabilityId[] {
  const held = new Set<CapabilityId>();
  for (const id of feature.capabilities) {
    if (plan?.capabilities[id]?.approved !== true) continue;
    for (const dependent of dependentsOf(plan, id)) {
      if (!feature.capabilities.includes(dependent)) held.add(dependent);
    }
  }
  return [...held].sort();
}

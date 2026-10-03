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
 * collector and Certificate authority no Host issuance surface
 * (`modules/<id>/runtime.ts` say so). A switch
 * for one changes nothing a person can see, so Settings draws none (ADR 0158).
 */
export const NO_SURFACE: ReadonlySet<CapabilityId> = new Set([
  "telemetry.external",
  "enterprise.ca-administration",
]);

/** The feature as Settings draws it: the capabilities a switch can change. */
export function shown(feature: Feature): Feature {
  return feature.capabilities.some((id) => NO_SURFACE.has(id))
    ? {
        ...feature,
        capabilities: feature.capabilities.filter((id) => !NO_SURFACE.has(id)),
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

/**
 * Local composition flag provider: plan activation → boolean flags.
 *
 * Minimal OpenFeature-shaped provider with no network, no SDK dependency:
 * a flag is true only when its capability's activationStatus is "active" in
 * the last evaluated plan. Default false — an unevaluated or non-active
 * capability never enables a code path.
 */
import type {
  ActivationStatus,
  EffectivePlan,
} from "@opensesame/capability-composition";

export type FlagValue = {
  readonly key: string;
  readonly enabled: boolean;
  readonly reason: string;
};

export class CompositionFlagProvider {
  private plan: EffectivePlan | undefined;

  /** Install the plan flags resolve against. */
  setPlan(plan: EffectivePlan): void {
    this.plan = plan;
  }

  /** Boolean flag for a capability id; false unless active. */
  booleanFlag(capabilityId: string): FlagValue {
    const entry = this.plan?.selected.find((c) => c.id === capabilityId);
    const enabled = entry?.activationStatus === "active";
    return {
      key: `composition.${capabilityId}`,
      enabled,
      reason: entry ? entry.activationStatus : "no-plan",
    };
  }

  /** Every flag in the current plan (active or not). */
  allFlags(): readonly FlagValue[] {
    if (!this.plan) return [];
    return this.plan.selected.map((c) => this.booleanFlag(c.id));
  }
}

/** Activation statuses that enable a flag: exactly "active". */
export function enablesFlag(status: ActivationStatus): boolean {
  return status === "active";
}

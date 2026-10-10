/**
 * How far a recovery has got against what its circle's rule asks for (ADR 0186
 * §10), counted the shortest true way so a screen can say "1 of 2" and be right.
 *
 * A circle with one group asks for a number of its contacts: that is the count.
 * A circle with several groups asks for a number of groups to have met their
 * own thresholds, and a count of contacts would be a wrong number for it, so
 * the count is groups. Pure: it reads a policy's rule and a set of ids.
 */

import type { CirclePolicy } from "../types.js";

export type Progress = Readonly<{
  /** How many have been counted, never more than `need`. */
  have: number;
  /** What the rule asks for. */
  need: number;
  /** What `have` and `need` count. */
  unit: "contacts" | "groups";
}>;

export function progressToward(
  policy: Pick<CirclePolicy, "groups" | "groupThreshold">,
  guardianIds: readonly string[],
): Progress {
  const named = new Set(guardianIds);
  const inGroup = (group: CirclePolicy["groups"][number]) =>
    group.guardianIds.filter((id) => named.has(id)).length;
  const [only] = policy.groups;
  if (policy.groups.length === 1 && only) {
    return {
      have: Math.min(inGroup(only), only.threshold),
      need: only.threshold,
      unit: "contacts",
    };
  }
  const met = policy.groups.filter(
    (group) => inGroup(group) >= group.threshold,
  ).length;
  return {
    have: Math.min(met, policy.groupThreshold),
    need: policy.groupThreshold,
    unit: "groups",
  };
}

/**
 * What a version-1 preset left behind (ADR 0142).
 *
 * A version-1 preset projection wrote every optional id the preset did not
 * offer into `prohibited`. ADR 0142 made the site broker and git backup
 * always on, so in such a policy their listing is residue of the projection
 * — nobody chose it — and reading it as an operator's withdrawal would take
 * git backup away from every Personal and Family device set up before. It
 * is dropped when the policy is read, from `required` and `optional` as
 * well, where the projection listed them as offered. Identity is optional
 * again (ADR 0153), so a version-1 listing of it stands. A policy written
 * by hand, or projected by a version-2 preset, still withdraws what it names.
 */

import type {
  CapabilityId,
  InstanceCapabilityPolicy,
} from "@opensesame/capability-composition";

const PROMOTED_TO_ALWAYS_ON: ReadonlySet<CapabilityId> = new Set([
  "identity.site-broker",
  "backup.git-remote",
  "sharing.drops",
]);

const PRESET_IDS: ReadonlySet<string> = new Set([
  "personal",
  "family",
  "homelab",
  "organization",
  "custom",
]);

export function withoutPresetResidue(
  policy: InstanceCapabilityPolicy,
): InstanceCapabilityPolicy {
  const from = policy.presetProvenance;
  if (from === null || from.version !== 1 || !PRESET_IDS.has(from.id)) {
    return policy;
  }
  // The projection also listed the promoted ids as offered: in `optional`
  // (or `required`) they are residue too, and a core id there is only a
  // standing diagnostic on every boot.
  const caps = policy.capabilities;
  const keep = (ids: readonly CapabilityId[]) =>
    ids.filter((id) => !PROMOTED_TO_ALWAYS_ON.has(id));
  const stripped = {
    ...caps,
    required: keep(caps.required),
    optional: keep(caps.optional),
    prohibited: keep(caps.prohibited),
  };
  const unchanged =
    stripped.required.length === caps.required.length &&
    stripped.optional.length === caps.optional.length &&
    stripped.prohibited.length === caps.prohibited.length;
  return unchanged ? policy : { ...policy, capabilities: stripped };
}

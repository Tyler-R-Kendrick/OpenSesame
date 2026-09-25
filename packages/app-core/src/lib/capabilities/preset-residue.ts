/**
 * What a version-1 preset left behind (ADR 0142).
 *
 * A version-1 preset projection wrote every optional id the preset did not
 * offer into `prohibited`. ADR 0142 made four of those always on, so in such
 * a policy their listing is residue of the projection — nobody chose it —
 * and reading it as an operator's withdrawal would take git backup and
 * browser-local sign-in away from every Personal and Family device set up
 * before. It is dropped when the policy is read. A policy written by hand, or
 * projected by a version-2 preset, still withdraws them.
 */

import type {
  CapabilityId,
  InstanceCapabilityPolicy,
} from "@opensesame/capability-composition";

const PROMOTED_TO_ALWAYS_ON: ReadonlySet<CapabilityId> = new Set([
  "identity.local-iam",
  "identity.siop",
  "identity.site-broker",
  "backup.git-remote",
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
  const listed = policy.capabilities.prohibited;
  const prohibited = listed.filter((id) => !PROMOTED_TO_ALWAYS_ON.has(id));
  if (prohibited.length === listed.length) return policy;
  return { ...policy, capabilities: { ...policy.capabilities, prohibited } };
}

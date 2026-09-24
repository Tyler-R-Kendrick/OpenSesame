/**
 * Purpose presets (ownership.md §3 S02, §5). A preset is a starting point an
 * operator or a person picks; it never approves anything by itself. `required`
 * must be accepted to join, `optional` is offered unselected, and
 * `defaultSelected` is pre-ticked in the draft and still needs Apply and a
 * consent receipt. Every id here is a catalog id; the test pins that and that
 * Personal and Family never pre-select connectors, enterprise, agents, remote
 * AI or telemetry.
 */

import type {
  CapabilityId,
  InstanceCapabilityPolicy,
  NetworkPolicy,
} from "@opensesame/capability-composition";
import { optionalCapabilityIds } from "./catalog.js";

export type PresetId =
  | "personal"
  | "family"
  | "homelab"
  | "organization"
  | "custom";

export type Preset = Readonly<{
  id: PresetId;
  version: 1;
  title: string;
  summary: string;
  required: readonly CapabilityId[];
  /** Offered, unselected. */
  optional: readonly CapabilityId[];
  /** Pre-ticked in the draft; still needs Apply. */
  defaultSelected: readonly CapabilityId[];
  network: NetworkPolicy;
}>;

const ALLOW: NetworkPolicy = {
  externalServices: "allow",
  allowedServiceOrigins: [],
};
const DENY: NetworkPolicy = {
  externalServices: "deny",
  allowedServiceOrigins: [],
};

/**
 * Optional functions that run on this device with no connector, enterprise,
 * agent, remote-AI or telemetry surface. Personal and Family offer only
 * these. Browser-local IAM, SIOP, the site broker and git backup are always
 * on (ADR 0138), so no preset names them.
 */
export const LOCAL_FUNCTIONS: readonly CapabilityId[] = [
  "sharing.drops",
  "support.local-ai",
];

/** Families a Personal or Family preset never offers or pre-selects. */
export const RESTRICTED_FAMILIES: readonly string[] = [
  "connectors.",
  "enterprise.",
  "agents.",
  "telemetry.",
];
export const RESTRICTED_IDS: readonly CapabilityId[] = ["support.remote-ai"];

export function isRestrictedForHome(id: CapabilityId): boolean {
  return (
    RESTRICTED_IDS.includes(id) ||
    RESTRICTED_FAMILIES.some((family) => id.startsWith(family))
  );
}

const everyOptional = (): CapabilityId[] => optionalCapabilityIds();

export const PRESETS: readonly Preset[] = [
  {
    id: "personal",
    version: 1,
    title: "Personal",
    summary:
      "One person's vault on their own devices. Only local features are offered; the always-on functions stay as they are.",
    required: [],
    optional: LOCAL_FUNCTIONS,
    defaultSelected: [],
    network: ALLOW,
  },
  {
    id: "family",
    version: 1,
    title: "Family",
    summary:
      "A household sharing chosen items with each other. Local features and drops, and no automatic call to an external service.",
    required: [],
    optional: [...LOCAL_FUNCTIONS, "sharing.household"],
    defaultSelected: ["sharing.household", "sharing.drops"],
    network: DENY,
  },
  {
    id: "homelab",
    version: 1,
    title: "Homelab",
    summary:
      "A self-hosted Host and Identity API at home. Everything is offered; enterprise and agent tools wait to be chosen.",
    required: [],
    optional: everyOptional(),
    defaultSelected: [],
    network: ALLOW,
  },
  {
    id: "organization",
    version: 1,
    title: "Organization",
    summary:
      "An operator-run instance people join. Sign-in through the organization's providers and the access authority are always on; enterprise and agent tools are offered, not pre-selected.",
    required: [],
    optional: everyOptional(),
    defaultSelected: [],
    network: ALLOW,
  },
  {
    id: "custom",
    version: 1,
    title: "Custom",
    summary: "Every optional capability offered, nothing pre-selected.",
    required: [],
    optional: everyOptional(),
    defaultSelected: [],
    network: ALLOW,
  },
];

export function presetById(id: PresetId): Preset {
  const preset = PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`unknown preset ${id}`);
  return preset;
}

/**
 * Project a preset onto an instance policy. Optional capabilities the preset
 * does not offer are recorded as deliberate refusals in `prohibited`, so a
 * later preset switch cannot quietly add them (`capabilities.default` is
 * always `deny`). Pure: same inputs, same document.
 */
export function presetToInstancePolicy(
  preset: Preset,
  instanceId: string,
  revision: string,
): InstanceCapabilityPolicy {
  const offered = new Set<CapabilityId>([
    ...preset.required,
    ...preset.optional,
  ]);
  return {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId,
    revision,
    presetProvenance: { id: preset.id, version: preset.version },
    capabilities: {
      default: "deny",
      required: [...preset.required].sort(),
      optional: [...preset.optional].sort(),
      prohibited: optionalCapabilityIds()
        .filter((id) => !offered.has(id))
        .sort(),
    },
    network: preset.network,
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
  };
}

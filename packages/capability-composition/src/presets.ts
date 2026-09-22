/**
 * The five composition presets as *names plus suggestions* — never as
 * capability ids.
 *
 * A preset cannot silently grow: actual ids come from the catalog the caller
 * passes to `resolvePreset`. The resolver itself never accepts a wildcard;
 * a catalog missing a suggested key is a validation failure, not a default.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { isString } from "@opensesame/os-domain";

export const PRESET_NAMES = [
  "personal",
  "family",
  "homelab",
  "organization",
  "custom",
] as const;

export type PresetName = (typeof PRESET_NAMES)[number];

export type PresetDefinition = {
  readonly name: PresetName;
  readonly description: string;
  /**
   * Suggested capability *roles* in preference order. These are catalog
   * keys, not capability ids; `resolvePreset` maps each key through the
   * catalog passed in and fails closed on a missing key.
   */
  readonly orderedSuggestions: readonly string[];
};

export const PRESET_ENTRIES = [
  [
    "personal",
    {
      name: "personal",
      description:
        "One person, their own devices; every privilege-granting capability opt-in.",
      orderedSuggestions: ["core.credentials.view", "core.fill.manual"],
    },
  ],
  [
    "family",
    {
      name: "family",
      description:
        "A household share; adds item sharing but no external egress by default.",
      orderedSuggestions: [
        "core.credentials.view",
        "core.fill.manual",
        "core.share.household",
      ],
    },
  ],
  [
    "homelab",
    {
      name: "homelab",
      description:
        "Self-hosted services; local network egress to explicitly allowed origins.",
      orderedSuggestions: [
        "core.credentials.view",
        "core.fill.manual",
        "core.share.household",
        "core.egress.lan",
      ],
    },
  ],
  [
    "organization",
    {
      name: "organization",
      description:
        "Managed deployment; policy-owned allow-lists and audit-forwarding.",
      orderedSuggestions: [
        "core.credentials.view",
        "core.fill.manual",
        "core.share.organization",
        "core.audit.forward",
      ],
    },
  ],
  [
    "custom",
    {
      name: "custom",
      description:
        "Fully operator-composed; no suggestions of its own, every id explicit.",
      orderedSuggestions: [],
    },
  ],
] as const satisfies ReadonlyArray<readonly [PresetName, PresetDefinition]>;

const PRESETS_BY_NAME = new Map<PresetName, PresetDefinition>(
  PRESET_ENTRIES.map(([name, definition]) => [name, definition]),
);

function presetOrThrow(name: PresetName): PresetDefinition {
  const found = PRESETS_BY_NAME.get(name);
  if (!found) throw new Error(`preset table missing ${name}`);
  return found;
}

export const PRESETS = {
  personal: presetOrThrow("personal"),
  family: presetOrThrow("family"),
  homelab: presetOrThrow("homelab"),
  organization: presetOrThrow("organization"),
  custom: presetOrThrow("custom"),
} as const satisfies Readonly<Record<PresetName, PresetDefinition>>;

/** A catalog mapping suggestion keys to explicit capability ids. */
export type PresetCatalog = Readonly<Record<string, readonly string[]>>;

export type PresetResolution =
  | {
      readonly ok: true;
      readonly name: PresetName;
      readonly required: readonly string[];
      readonly optional: readonly string[];
    }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * Resolve a preset against a catalog to explicit capability ids. The first
 * suggestion in `orderedSuggestions` becomes required; the rest become
 * optional suggestions. A catalog missing a key fails closed with the list
 * of missing keys — never a silent default, never a wildcard.
 */
export function resolvePreset(
  name: PresetName,
  catalog: PresetCatalog,
): PresetResolution {
  const preset = PRESETS[name];
  const missing: string[] = [];
  for (const key of preset.orderedSuggestions) {
    const ids = catalog[key];
    if (!Array.isArray(ids)) missing.push(key);
  }
  if (missing.length > 0) return { ok: false, missing };
  const required: string[] = [];
  const optional: string[] = [];
  preset.orderedSuggestions.forEach((key, index) => {
    const ids = catalog[key] ?? [];
    if (index === 0) required.push(...ids);
    else optional.push(...ids);
  });
  return { ok: true, name, required, optional };
}

/** True only for one of the five preset names. */
export function isPresetName(value: BoundaryValue): value is PresetName {
  return (
    isString(value) &&
    PRESET_NAMES.some((name: PresetName) => name === value)
  );
}

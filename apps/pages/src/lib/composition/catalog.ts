import {
  type PresetCatalog,
  type PresetName,
  type ResolverInput,
  resolvePreset,
} from "@opensesame/capability-composition";
import { CAPABILITIES, type Capability } from "@opensesame/capability-registry";
/**
 * Composition catalog: preset suggestion keys → explicit registry ids.
 *
 * Maps the five composition presets' suggestion keys (presets.ts, names plus
 * suggestions never ids) onto the operation-ID authority
 * (@opensesame/capability-registry CAPABILITIES). The registry stays the
 * authority; this module only selects explicit ids from it. Never import
 * apps/pages/src/lib/capabilities.ts here — that is the connector-binding
 * capability universe, a different system.
 */
import type { BoundaryValue } from "@opensesame/os-domain";

/** Suggestion keys the composition presets may name. */
export const SUGGESTION_KEYS = [
  "core.credentials.view",
  "core.fill.manual",
  "core.share.household",
  "core.share.organization",
  "core.egress.lan",
  "core.audit.forward",
] as const;

export type SuggestionKey = (typeof SUGGESTION_KEYS)[number];

/**
 * Explicit registry ids per suggestion key, chosen by title/plane/kind:
 * credential viewing reads vault metadata, manual fill reveals through the
 * ceremony, household shares delegate, organization shares delegate plus
 * audit, LAN egress syncs, audit forwarding reads findings.
 */
const SUGGESTIONS: Readonly<Record<SuggestionKey, readonly string[]>> = {
  "core.credentials.view": ["vault.items.search", "vault.items.read_meta"],
  "core.fill.manual": ["vault.items.reveal", "vault.totp.code"],
  "core.share.household": ["delegations.offers.mint", "delegations.claim"],
  "core.share.organization": [
    "delegations.offers.mint",
    "delegations.claim",
    "security.findings.read",
  ],
  "core.egress.lan": ["sync.push", "sync.pull"],
  "core.audit.forward": ["security.findings.read", "configs.audit"],
};

const KNOWN_IDS = new Set(CAPABILITIES.map((c) => c.id));

for (const [key, ids] of Object.entries(SUGGESTIONS)) {
  for (const id of ids) {
    if (!KNOWN_IDS.has(id)) {
      throw new Error(
        `composition catalog suggestion ${key} names unknown id ${id}`,
      );
    }
  }
}

/** The preset catalog: suggestion key → explicit registry ids. */
export function buildCompositionCatalog(): PresetCatalog {
  return { ...SUGGESTIONS };
}

/** The registry entry behind an id, or undefined when unknown. */
export function registryEntry(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/** Minimal valid descriptors for explicit ids (document runtime, no privileges). */
export function toDescriptors(ids: readonly string[]): BoundaryValue[] {
  return ids.map((id) => ({
    id,
    descriptorVersion: 1,
    title: registryEntry(id)?.title ?? id,
    summary: "",
    dependencies: [],
    operationIds: operationTokens(id),
    moduleIds: [`mod.${id}`],
    environments: ["document"],
    exposureDigest: "0".repeat(16),
    requiresDocumentReload: false,
    declaredPrivileges: {
      egressOrigins: [],
      keyAccess: { vaultRead: false, vaultWrite: false, deviceKeys: false },
      browserPermissions: [],
    },
  }));
}

/** Operation ids for a registry id: dotted capability id plus surface slugs. */
function operationTokens(id: string): string[] {
  const entry = registryEntry(id);
  if (!entry) return [];
  const slugs = [
    entry.surfaces.cli,
    entry.surfaces.pwa,
    entry.surfaces.mcp_host,
    entry.surfaces.mcp_client,
    entry.surfaces.webmcp,
  ];
  const ops = [id];
  for (const slug of slugs) {
    if (slug === null) continue;
    const cleaned = slug
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, ".")
      .replaceAll(/^\.+|\.+$/g, "");
    if (cleaned && !ops.includes(cleaned)) ops.push(cleaned);
  }
  return ops;
}

/** Resolve a preset to a ResolverInput over the composition catalog. */
export function resolvePresetToPlanInput(
  name: PresetName,
  catalog: PresetCatalog = buildCompositionCatalog(),
): ResolverInput {
  const resolved = resolvePreset(name, catalog);
  if (!resolved.ok) {
    throw new Error(
      `preset ${name} missing catalog keys: ${resolved.missing.join(",")}`,
    );
  }
  const ids = [...resolved.required, ...resolved.optional];
  return {
    distribution: {
      distributionId: `catalog-${name}`,
      descriptors: toDescriptors(ids),
      moduleIds: ids.map((id) => `mod.${id}`),
      cachedCapabilityIds: [],
    },
    instancePolicy: {
      schemaVersion: 1,
      kind: "instance-policy",
      instanceId: "catalog",
      revision: 1,
      required: [...resolved.required],
      optional: [...resolved.optional],
      prohibited: [],
      network: { externalServices: "deny", allowedServiceOrigins: [] },
      updates: {
        unknownCapabilities: "deny",
        expandedExposure: "require-approval",
      },
    },
    runtimeEnvironments: ["document"],
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  };
}

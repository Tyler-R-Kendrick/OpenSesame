/**
 * Shared test builders. Not exported from the package index — tests only.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { isJsonObject, isString } from "@opensesame/os-domain";
import type { DistributionInventory } from "./resolver.js";

const ZERO_DIGEST = "0".repeat(16);

/** Overrides for a fixture builder: partial raw fields, type-checked. */
export type FixtureOverrides = {
  readonly dependencies?: readonly string[] | string;
  readonly operationIds?: readonly (string | number)[];
  readonly moduleIds?: readonly string[];
  readonly environments?: readonly string[];
  readonly exposureDigest?: string;
  readonly title?: string | string[];
  readonly summary?: string | (() => string) | number;
  readonly requiresDocumentReload?: boolean;
  readonly declaredPrivileges?: {
    readonly egressOrigins?: readonly string[];
    readonly keyAccess?: Record<string, boolean | string>;
    readonly browserPermissions?: readonly string[];
  };
  readonly workerGraphConstraint?: {
    readonly requiresWorker?: boolean;
    readonly allowedEnvironments?: readonly string[];
  };
  readonly class?: string;
} & {
  readonly [extra: string]: BoundaryValue | undefined;
};

/** A minimal descriptor object (unvalidated) for a capability. */
export function descriptor(id: string, overrides: FixtureOverrides = {}): BoundaryValue {
  const {
    dependencies,
    operationIds,
    moduleIds,
    environments,
    exposureDigest,
    title,
    summary,
    requiresDocumentReload,
    declaredPrivileges,
    workerGraphConstraint,
    class: klass,
    ...hostile
  } = overrides;
  const raw: Record<string, BoundaryValue> = {
    id,
    descriptorVersion: 1,
    title: `Title ${id}`,
    summary: "",
    dependencies: [],
    operationIds: [],
    moduleIds: [`mod.${id}`],
    environments: ["document"],
    exposureDigest: ZERO_DIGEST,
    requiresDocumentReload: false,
    declaredPrivileges: {
      egressOrigins: [],
      keyAccess: { vaultRead: false, vaultWrite: false, deviceKeys: false },
      browserPermissions: [],
    },
  };
  if (dependencies !== undefined) raw.dependencies = [...dependencies];
  if (operationIds !== undefined) raw.operationIds = [...operationIds];
  if (moduleIds !== undefined) raw.moduleIds = [...moduleIds];
  if (environments !== undefined) raw.environments = [...environments];
  if (exposureDigest !== undefined) raw.exposureDigest = exposureDigest;
  if (title !== undefined) raw.title = title;
  if (summary !== undefined) {
    // SAFETY: the hostile summary shapes under test (function, number) are
    // the validator's own rejection cases; the fixture type names them.
    raw.summary = summary as BoundaryValue;
  }
  if (requiresDocumentReload !== undefined) {
    raw.requiresDocumentReload = requiresDocumentReload;
  }
  if (declaredPrivileges !== undefined) {
    raw.declaredPrivileges = {
      egressOrigins: [...(declaredPrivileges.egressOrigins ?? [])],
      keyAccess: { ...(declaredPrivileges.keyAccess ?? {}) },
      browserPermissions: [...(declaredPrivileges.browserPermissions ?? [])],
    };
  }
  if (workerGraphConstraint !== undefined) {
    raw.workerGraphConstraint = {
      requiresWorker: workerGraphConstraint.requiresWorker,
      allowedEnvironments: [...(workerGraphConstraint.allowedEnvironments ?? [])],
    };
  }
  if (klass !== undefined) raw.class = klass;
  for (const [key, value] of Object.entries(hostile)) {
    raw[key] = value;
  }
  return raw;
}

/** Policy overrides parsed from attacker-shaped JSON at the test boundary. */
export type HostilePolicyFields = {
  readonly [extra: string]: BoundaryValue | undefined;
};

/**
 * Parse attacker-shaped JSON into the hostile-fields contract: the only
 * producer of `HostilePolicyFields`, so no test parses raw JSON inline.
 */
export function hostileFields(text: string): HostilePolicyFields {
  return JSON.parse(text) as HostilePolicyFields;
}

/** Overrides for a fixture policy: partial raw fields, type-checked. */
export type FixturePolicy = {
  readonly schemaVersion?: number;
  readonly kind?: string;
  readonly instanceId?: string;
  readonly revision?: number;
  readonly required?: readonly string[];
  readonly optional?: readonly string[];
  readonly prohibited?: readonly string[];
  readonly network?: {
    readonly externalServices?: string;
    readonly allowedServiceOrigins?: readonly string[];
  };
  readonly updates?: {
    readonly unknownCapabilities?: string;
    readonly expandedExposure?: string;
  };
} & {
  readonly [extra: string]: BoundaryValue | undefined;
};

/** An instance policy document with sensible defaults. */
export function policy(overrides: FixturePolicy = {}): BoundaryValue {
  const {
    schemaVersion = 1,
    kind = "instance-policy",
    instanceId = "inst-1",
    revision = 3,
    required = [],
    optional = [],
    prohibited = [],
    network,
    updates,
    ...hostile
  } = overrides;
  const raw: Record<string, BoundaryValue> = {
    schemaVersion,
    kind,
    instanceId,
    revision,
    required: [...required],
    optional: [...optional],
    prohibited: [...prohibited],
    network: {
      externalServices: network?.externalServices ?? "deny",
      allowedServiceOrigins: [...(network?.allowedServiceOrigins ?? [])],
    },
    updates: {
      unknownCapabilities: updates?.unknownCapabilities ?? "deny",
      expandedExposure: updates?.expandedExposure ?? "require-approval",
    },
  };
  for (const [key, value] of Object.entries(hostile)) {
    raw[key] = value;
  }
  return raw;
}

/** Overrides for a fixture vault restriction: partial raw fields. */
export type FixtureVault = {
  readonly instanceId?: string;
  readonly vaultId?: string;
  readonly basePolicyRevision?: number;
  readonly revision?: number;
  readonly allow?:
    | string
    | { readonly ids: readonly string[] }
    | { readonly ids?: BoundaryValue }
    | Record<string, BoundaryValue>
    | number
    | undefined;
  readonly optional?: readonly string[];
  readonly prohibited?: readonly string[];
} & {
  readonly [extra: string]: BoundaryValue | undefined;
};

/** A vault restriction document. */
export function vaultRestriction(overrides: FixtureVault = {}): BoundaryValue {
  const {
    instanceId = "inst-1",
    vaultId = "vault-1",
    basePolicyRevision = 3,
    revision = 1,
    allow = "inherit",
    optional = [],
    prohibited = [],
    ...hostile
  } = overrides;
  const raw: Record<string, BoundaryValue> = {
    schemaVersion: 1,
    kind: "vault-restriction",
    instanceId,
    vaultId,
    basePolicyRevision,
    revision,
    allow:
      typeof allow === "string" || typeof allow === "number" || allow === undefined
        ? allow
        : Array.isArray(allow.ids)
          ? { ids: [...allow.ids] }
          : // SAFETY: hostile allow.ids shapes ({}, "x") are the validator's
            // own rejection cases; the fixture type names every variant.
            { ids: allow.ids as BoundaryValue },
    optional: [...optional],
    prohibited: [...prohibited],
  };
  for (const [key, value] of Object.entries(hostile)) {
    raw[key] = value;
  }
  return raw;
}

/** Overrides for a fixture selection: partial raw fields. */
export type FixtureSelection = {
  readonly instanceId?: string;
  readonly vaultId?: string | null;
  readonly vaultIdSource?: string;
  readonly installationId?: string;
  readonly revision?: number;
  readonly required?: readonly string[] | string;
  readonly optional?: readonly string[] | string;
  readonly prohibited?: readonly string[];
  readonly allow?:
    | string
    | { readonly ids: readonly string[] }
    | { readonly ids?: BoundaryValue }
    | Record<string, BoundaryValue>
    | number
    | undefined;
} & {
  readonly [extra: string]: BoundaryValue | undefined;
};

/** An installation selection document. */
export function selection(overrides: FixtureSelection = {}): BoundaryValue {
  const {
    instanceId = "inst-1",
    vaultId = null,
    vaultIdSource = "derived",
    installationId = "install-1",
    revision = 7,
    required = [],
    optional = [],
    prohibited = [],
    allow = "inherit",
    ...hostile
  } = overrides;
  const raw: Record<string, BoundaryValue> = {
    schemaVersion: 1,
    kind: "installation-selection",
    instanceId,
    vaultId,
    vaultIdSource,
    installationId,
    revision,
    // SAFETY: hostile required/optional shapes (plain "x") are the
    // validator's own rejection cases; the fixture type names them.
    required: (Array.isArray(required) ? [...required] : required) as BoundaryValue,
    optional: (Array.isArray(optional) ? [...optional] : optional) as BoundaryValue,
    prohibited: [...prohibited],
    allow:
      typeof allow === "string" || typeof allow === "number" || allow === undefined
        ? allow
        : Array.isArray(allow.ids)
          ? { ids: [...allow.ids] }
          : // SAFETY: hostile allow.ids shapes ({}, "x") are the validator's
            // own rejection cases; the fixture type names every variant.
            { ids: allow.ids as BoundaryValue },
  };
  for (const [key, value] of Object.entries(hostile)) {
    raw[key] = value;
  }
  return raw;
}

/** A distribution inventory from descriptors. */
export function distribution(
  descriptors: readonly BoundaryValue[],
  overrides: Record<string, BoundaryValue> = {},
): DistributionInventory {
  const moduleIds: string[] = [];
  for (const raw of descriptors) {
    if (!isJsonObject(raw) || !Array.isArray(raw.moduleIds)) continue;
    for (const module of raw.moduleIds) {
      if (isString(module) && !moduleIds.includes(module)) {
        moduleIds.push(module);
      }
    }
  }
  return {
    distributionId: "dist-1",
    descriptors: [...descriptors],
    moduleIds,
    cachedCapabilityIds: [],
    ...overrides,
  };
}

/** Deterministic xorshift PRNG over a 32-bit seed. */
export function makePrng(seed: number): () => number {
  let state = seed | 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 0) / 0x100000000;
  };
}

/** Fisher-Yates shuffle with the given prng. */
export function shuffled<T>(items: readonly T[], prng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(prng() * (i + 1));
    // SAFETY: i and j are both in-bounds indices the loop established (j is
    // floored into 0..i), so indexed reads below are defined, not holes.
    const atI = out[i];
    const atJ = out[j];
    if (atI === undefined || atJ === undefined) continue;
    out[i] = atJ;
    out[j] = atI;
  }
  return out;
}

/**
 * Shared test builders. Not exported from the package index — tests only.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import type { DistributionInventory } from "./resolver.js";

const ZERO_DIGEST = "0".repeat(16);

/** A minimal descriptor object (unvalidated) for a capability. */
export function descriptor(
  id: string,
  overrides: Record<string, BoundaryValue> = {},
): BoundaryValue {
  return {
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
    ...overrides,
  };
}

/** An instance policy document with sensible defaults. */
export function policy(
  overrides: Record<string, BoundaryValue> = {},
): BoundaryValue {
  return {
    schemaVersion: 1,
    kind: "instance-policy",
    instanceId: "inst-1",
    revision: 3,
    required: [],
    optional: [],
    prohibited: [],
    network: { externalServices: "deny", allowedServiceOrigins: [] },
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
    ...overrides,
  };
}

/** A vault restriction document. */
export function vaultRestriction(
  overrides: Record<string, BoundaryValue> = {},
): BoundaryValue {
  return {
    schemaVersion: 1,
    kind: "vault-restriction",
    instanceId: "inst-1",
    vaultId: "vault-1",
    basePolicyRevision: 3,
    revision: 1,
    allow: "inherit",
    optional: [],
    prohibited: [],
    ...overrides,
  };
}

/** An installation selection document. */
export function selection(
  overrides: Record<string, BoundaryValue> = {},
): BoundaryValue {
  return {
    schemaVersion: 1,
    kind: "installation-selection",
    instanceId: "inst-1",
    vaultId: null,
    vaultIdSource: "derived",
    installationId: "install-1",
    revision: 7,
    required: [],
    optional: [],
    prohibited: [],
    allow: "inherit",
    ...overrides,
  };
}

/** A distribution inventory from descriptors. */
export function distribution(
  descriptors: readonly BoundaryValue[],
  overrides: Record<string, BoundaryValue> = {},
): DistributionInventory {
  return {
    distributionId: "dist-1",
    descriptors: [...descriptors],
    moduleIds: descriptors.flatMap(
      (d) => (d as { moduleIds: string[] }).moduleIds,
    ),
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
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

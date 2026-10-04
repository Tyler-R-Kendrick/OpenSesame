import type {
  CapabilityState,
  EffectivePlan,
} from "@opensesame/capability-composition";
import { CAPABILITY_CATALOG } from "../catalog.js";

/**
 * A plan in which the named capabilities run and every optional one may;
 * `overrides` changes single capabilities' states on top of that.
 */
export function planWith(
  approved: readonly string[],
  overrides: ReadonlyMap<string, Partial<CapabilityState>> = new Map(),
): EffectivePlan {
  const capabilities: Record<string, CapabilityState> = {};
  for (const entry of CAPABILITY_CATALOG.capabilities) {
    capabilities[entry.id] = {
      id: entry.id,
      tier: entry.tier,
      distributed: true,
      permitted: true,
      required: false,
      selected: approved.includes(entry.id),
      dependencyOf: [],
      runtimeSupported: true,
      missingEnvironments: [],
      approved: entry.tier === "core" || approved.includes(entry.id),
      restartRequired: false,
      reasons: [],
      ...overrides.get(entry.id),
    };
  }
  return {
    identity: {
      instanceId: "personal-local",
      installationId: "features-test",
      vaultId: null,
      distributionId: "features-test",
      policyRevision: "personal-local",
      selectionRevision: "1",
      planDigest: "sha256:features-test",
    },
    provenance: "personal-local",
    policyValid: true,
    capabilities,
    approvedCapabilities: Object.values(capabilities)
      .filter((state) => state.approved)
      .map((state) => state.id),
    approvedModules: [],
    approvedOperations: [],
    approvedItemKinds: [],
    requiredWorkerVariant: null,
    conflicts: [],
    consent: {
      addedRoots: [],
      removedRoots: [],
      changedExposure: [],
      addedDependencies: [],
      requiredNotAccepted: [],
    },
    network: { externalServices: "allow", allowedServiceOrigins: [] },
  };
}

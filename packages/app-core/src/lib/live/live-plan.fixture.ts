/**
 * Plans from the real resolver, with Live sessions selected or not, for the
 * tests of what a plan does to a running session (ADR 0150 §7).
 */

import {
  type CapabilityCatalog,
  type DistributionContract,
  type EffectivePlan,
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_POLICIES,
  buildCatalog,
  buildConsentReceipt,
  fixtureResolveInput,
  fixtureSelection,
  resolveComposition,
} from "@opensesame/capability-composition";
export const LIVE = "sharing.live";

const catalog: CapabilityCatalog = buildCatalog(
  [
    ...FIXTURE_CATALOG.capabilities.map(({ exposureDigest, ...rest }) => rest),
    {
      id: LIVE,
      descriptorVersion: 1,
      tier: "optional",
      title: "Live sessions",
      summary: "",
      dependencies: [],
      alternatives: [],
      operationIds: [],
      moduleIds: [`${LIVE}/runtime`],
      environments: ["document"],
      egress: [
        {
          class: "external-service",
          purpose: "code carriers",
          automatic: false,
        },
      ],
      browserPermissions: [],
      keyAccess: "none",
      requiresService: false,
      offlineLimits: "",
      workerGraphConstraint: null,
      requiresDocumentReload: false,
      itemKinds: [],
    },
  ],
  1,
);
const distribution: DistributionContract = {
  ...FIXTURE_DISTRIBUTION,
  capabilityIds: [...FIXTURE_DISTRIBUTION.capabilityIds, LIVE],
  moduleIds: [...FIXTURE_DISTRIBUTION.moduleIds, `${LIVE}/runtime`],
};

/**
 * A plan from the real resolver, with Live sessions selected or not, and
 * optionally the instance's network policy in place of the fixture's.
 */
export function plan(
  selected: boolean,
  prohibit = false,
  network?: EffectivePlan["network"],
): EffectivePlan {
  const base = {
    ...FIXTURE_POLICIES.family,
    network: network ?? FIXTURE_POLICIES.family.network,
  };
  const policy = prohibit
    ? {
        ...base,
        capabilities: {
          ...base.capabilities,
          optional: [...base.capabilities.optional, LIVE],
          prohibited: [...base.capabilities.prohibited, LIVE],
        },
      }
    : {
        ...base,
        capabilities: {
          ...base.capabilities,
          optional: [...base.capabilities.optional, LIVE],
        },
      };
  const input = fixtureResolveInput({
    catalog,
    distribution,
    instancePolicy: policy,
    provenance: "same-origin-deployment",
    installation: fixtureSelection({
      instanceId: policy.instanceId,
      basePolicyRevision: policy.revision,
      acceptedRequired: [...policy.capabilities.required],
      selectedOptional: selected ? [LIVE] : [],
    }),
  });
  // Two passes: approval needs the receipt the first pass says is owed.
  const receipt = buildConsentReceipt(
    resolveComposition(input),
    catalog,
    "2026-09-22T12:00:00.000Z",
  );
  return resolveComposition({ ...input, receipt });
}

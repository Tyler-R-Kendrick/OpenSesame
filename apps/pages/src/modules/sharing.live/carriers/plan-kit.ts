/**
 * Plans from the real resolver for the carriers' tests: the shipped catalog
 * and distribution, Live sessions selected (or not) under a policy of the
 * test's choosing, and the egress port and gate the module would be handed.
 * Imported by tests only.
 */

import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import {
  type EffectivePlan,
  type InstanceCapabilityPolicy,
  buildConsentReceipt,
  fixtureSelection,
  resolveComposition,
} from "@opensesame/capability-composition";
import { distributionFromOwnership } from "../../../lib/capabilities/ownership.js";
import { CAPABILITY, type CarrierGate } from "./allowed.js";

export const NOW = "2026-09-28T00:00:00.000Z";
export const SELF = "https://vault.example.test";

export type Net = InstanceCapabilityPolicy["network"];

export function policy(
  network: Net,
  prohibited: string[] = [],
): InstanceCapabilityPolicy {
  return {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId: "inst-live",
    revision: "1",
    presetProvenance: null,
    capabilities: {
      default: "deny",
      required: [],
      optional: [CAPABILITY],
      prohibited,
    },
    network,
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
  };
}

/** A plan from the real resolver: Live sessions selected (or not) under `p`. */
export function planUnder(
  p: InstanceCapabilityPolicy,
  selected = true,
): EffectivePlan {
  const input = {
    catalog: CAPABILITY_CATALOG,
    distribution: distributionFromOwnership("selective"),
    instancePolicy: p,
    provenance: "same-origin-deployment",
    policyValid: true,
    workspace: null,
    installation: fixtureSelection({
      instanceId: p.instanceId,
      installationId: "device-live-1",
      basePolicyRevision: p.revision,
      acceptedRequired: [],
      selectedOptional: selected ? [CAPABILITY] : [],
    }),
    vault: null,
    receipt: null,
    facts: {
      environments: ["document", "dedicated-worker", "service-worker"],
      serviceWorkerAvailable: true,
      activeWorkerVariant: null,
      cleanRealm: true,
      evaluatedModuleIds: [],
      approvedAtLoad: [],
      now: NOW,
    },
    installationId: "device-live-1",
    vaultId: null,
  } as const;
  const receipt = buildConsentReceipt(
    resolveComposition(input),
    CAPABILITY_CATALOG,
    NOW,
  );
  return resolveComposition({ ...input, receipt });
}

/** The gate the module gets, reading the plan afresh on every ask. */
export function gateWith(
  read: () => EffectivePlan | null,
  fetchImpl: typeof fetch = async () => new Response("ok"),
): CarrierGate {
  const descriptor = CAPABILITY_CATALOG.capabilities.find(
    (d) => d.id === CAPABILITY,
  );
  if (!descriptor) throw new Error("catalog lacks sharing.live");
  return {
    plan: read,
    egress: createEgressPort({
      capability: descriptor,
      plan: read,
      allowedOrigins: [SELF],
      fetchImpl,
    }),
  };
}

/** The gate for a plan that does not change. */
export function gateFor(
  plan: EffectivePlan | null,
  fetchImpl?: typeof fetch,
): CarrierGate {
  return gateWith(() => plan, fetchImpl);
}

export const ALLOW_ALL: Net = {
  externalServices: "allow",
  allowedServiceOrigins: [],
};

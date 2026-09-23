/**
 * Plans and snapshots for the projection, trust and egress suites (S17/S03/
 * S18). Everything derives from the package fixtures through the real
 * resolver — two passes, because approval needs the receipt the first pass
 * says is owed.
 */

import {
  type CapabilityDescriptor,
  type CapabilityId,
  type EffectivePlan,
  FIXTURE_CATALOG,
  FIXTURE_POLICIES,
  type InstanceCapabilityPolicy,
  type ResolveInput,
  buildConsentReceipt,
  fixtureResolveInput,
  fixtureSelection,
  resolveComposition,
} from "@opensesame/capability-composition";
import type { ProjectedSnapshot } from "../openfeature.js";

export const NOW = "2026-09-22T12:00:00.000Z";

export function descriptorOf(id: CapabilityId): CapabilityDescriptor {
  const found = FIXTURE_CATALOG.capabilities.find((d) => d.id === id);
  if (found === undefined) throw new Error(`fixture catalog lacks ${id}`);
  return found;
}

/** A plan approving `selectedOptional` (and their closure) under `policy`. */
export function approvedPlan(
  selectedOptional: readonly CapabilityId[],
  policy: InstanceCapabilityPolicy | null = null,
  overrides: Partial<ResolveInput> = {},
): EffectivePlan {
  const instanceId = policy?.instanceId ?? "personal-local";
  const installation = fixtureSelection({
    instanceId,
    basePolicyRevision: policy?.revision ?? "personal-local",
    acceptedRequired: [...(policy?.capabilities.required ?? [])],
    selectedOptional: [...selectedOptional],
  });
  const input = fixtureResolveInput({
    instancePolicy: policy,
    provenance: policy === null ? "personal-local" : "same-origin-deployment",
    installation,
    ...overrides,
  });
  const first = resolveComposition(input);
  const receipt = buildConsentReceipt(first, FIXTURE_CATALOG, NOW);
  return resolveComposition({ ...input, receipt });
}

export const FAMILY_POLICY = FIXTURE_POLICIES.family;
export const MANAGED_POLICY = FIXTURE_POLICIES.managedProhibited;

export function readySnapshot(
  plan: EffectivePlan,
  generation = 1,
): ProjectedSnapshot {
  const lifecycle: Record<string, "approved-not-loaded" | "not-selected"> = {};
  for (const id of Object.keys(plan.capabilities)) {
    lifecycle[id] = plan.capabilities[id]?.approved
      ? "approved-not-loaded"
      : "not-selected";
  }
  return { status: "ready", plan, generation, lifecycle };
}

export function resolvingSnapshot(generation = 0): ProjectedSnapshot {
  return { status: "resolving", plan: null, generation, lifecycle: {} };
}

export type StoreDouble = {
  getSnapshot(): ProjectedSnapshot;
  subscribe(listener: () => void): () => void;
  set(next: ProjectedSnapshot, notify?: boolean): void;
  notify(): void;
  listenerCount(): number;
};

export function storeDouble(initial: ProjectedSnapshot): StoreDouble {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next, notify = true) {
      snapshot = next;
      if (notify) for (const listener of [...listeners]) listener();
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

/**
 * Shared test seams for the composition runtime: an in-memory "durable"
 * store behind `kvSeams`, a serializing fake lock manager, the package
 * fixtures wired into `storeSeams`, and helpers that build a draft plus the
 * receipt a person would sign for it.
 */

import {
  type ConsentReceipt,
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_FACTS,
  FIXTURE_INSTALLATION_ID,
  type InstallationCapabilitySelection,
  type InstanceCapabilityPolicy,
  buildConsentReceipt,
  fixtureResolveInput,
  resolveComposition,
} from "@opensesame/capability-composition";
import { kvSeams } from "../../kv.js";
import type { ParsedRuntimeConfig } from "../../runtime-config.js";
import { resetCapabilitiesChannelForTest } from "../channel.js";
import { resetEvaluatedModulesForTest } from "../facts.js";
import { resetLoaderForTest } from "../loader.js";
import { resetRegistryForTest } from "../registry.js";
import {
  type CompositionStore,
  compositionStore,
  storeSeams,
} from "../store.js";

export const NOW = "2026-09-22T12:00:00.000Z";

/** What survives a reload in these tests. */
export const durable = new Map<string, string>();
export const failures = { durableWrite: false };

export function installKv(): void {
  Object.assign(kvSeams, {
    kvGet: (key: string) => durable.get(key) ?? null,
    kvSetDurable: async (key: string, value: string) => {
      if (failures.durableWrite) throw new Error("opfs refused the write");
      durable.set(key, value);
    },
  });
}

export function fakeLocks() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
      const run = chain.then(callback);
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

export function installStoreSeams(): void {
  storeSeams.catalog = async () => FIXTURE_CATALOG;
  storeSeams.distribution = async () => FIXTURE_DISTRIBUTION;
  storeSeams.locks = () => fakeLocks();
  storeSeams.now = () => NOW;
  storeSeams.installationId = () => FIXTURE_INSTALLATION_ID;
  storeSeams.workspaceRestriction = () => null;
  storeSeams.reviewManagedPolicy = () => ({ ok: true, diagnostics: [] });
}

/** Fresh realm: storage, seams, registry, loader, singleton store. */
export function freshRealm(): void {
  durable.clear();
  failures.durableWrite = false;
  installKv();
  installStoreSeams();
  resetEvaluatedModulesForTest();
  resetLoaderForTest();
  resetRegistryForTest();
  resetCapabilitiesChannelForTest();
  compositionStore.resetForTest();
}

export function absentRuntimeConfig(): ParsedRuntimeConfig {
  return {
    status: "absent",
    endpoints: {},
    ambientAuth: undefined,
    capabilityComposition: null,
    diagnostics: [],
  };
}

export function managedRuntimeConfig(
  policy: InstanceCapabilityPolicy,
): ParsedRuntimeConfig {
  return {
    status: "ok",
    endpoints: {},
    ambientAuth: undefined,
    capabilityComposition: {
      instancePolicy: policy,
      provenance: "same-origin-deployment",
      diagnostics: [],
    },
    diagnostics: [],
  };
}

export function invalidRuntimeConfig(): ParsedRuntimeConfig {
  return {
    status: "invalid",
    endpoints: {},
    ambientAuth: undefined,
    capabilityComposition: {
      instancePolicy: null,
      provenance: "same-origin-deployment",
      diagnostics: ["capabilityComposition.instancePolicy: invalid"],
    },
    diagnostics: ["capabilityComposition.instancePolicy: invalid"],
  };
}

export async function bootPersonalLocal(
  store: CompositionStore = compositionStore,
  vaultId: string | null = null,
): Promise<void> {
  await store.boot({
    runtimeConfig: absentRuntimeConfig(),
    vaultId,
    facts: { ...FIXTURE_FACTS, now: NOW },
  });
}

/** A draft selecting `selectedOptional`, plus the receipt covering exactly it. */
export function draftFor(
  store: CompositionStore,
  selectedOptional: readonly string[],
  revision: string,
): { draft: InstallationCapabilitySelection; receipt: ConsentReceipt } {
  const plan = store.getSnapshot().plan;
  if (!plan) throw new Error("store not resolved");
  const draft: InstallationCapabilitySelection = {
    schemaVersion: 1,
    kind: "InstallationCapabilitySelection",
    instanceId: plan.identity.instanceId,
    installationId: FIXTURE_INSTALLATION_ID,
    basePolicyRevision: plan.identity.policyRevision,
    revision,
    acceptedRequired: [],
    selectedOptional: [...selectedOptional],
    chosenAlternatives: {},
    delivery: { prefetch: "none", offlineCache: "shell-only" },
  };
  const candidate = resolveComposition(
    fixtureResolveInput({
      installation: draft,
      instancePolicy: store.getSnapshot().policy,
      provenance: store.getSnapshot().provenance,
      facts: { ...FIXTURE_FACTS, now: NOW },
    }),
  );
  return {
    draft,
    receipt: buildConsentReceipt(candidate, FIXTURE_CATALOG, NOW),
  };
}

export function approved(store: CompositionStore): readonly string[] {
  return store.getSnapshot().plan?.approvedCapabilities ?? [];
}

export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function until(
  predicate: () => boolean,
  attempts = 200,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("condition not met");
}

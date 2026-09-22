/**
 * The composition store (ownership.md §4.1): one resolved plan per
 * generation, published to React through `useSyncExternalStore`, and the
 * only place a lease is minted.
 *
 * Authority moves in one direction. A draft is reviewed against the current
 * plan, committed under a Web Lock after a fresh durable read, written
 * durably *before* anything in memory changes, and only then published with a
 * new generation — which aborts the previous lease, so every module, route
 * and handler minted under it stops. Emergency disable is the one path that
 * changes memory first, because blocking now matters more than the write.
 *
 * Nothing here decides what a document means: `resolveComposition` does.
 */

import {
  type ActivationLease,
  type CapabilityCatalog,
  type CapabilityId,
  type CapabilityState,
  type CompositionChangeReview,
  type ConsentReceipt,
  type DistributionContract,
  type EffectivePlan,
  type InstallationCapabilitySelection,
  type InstanceCapabilityPolicy,
  type PolicyProvenance,
  type RuntimeFacts,
  type VaultCapabilitySelection,
  type WorkspaceCapabilityRestriction,
  PERSONAL_LOCAL_INSTANCE,
  computeConsentDelta,
  resolveComposition,
  reviewCompositionChange,
} from "@opensesame/capability-composition";
import { useSyncExternalStore } from "react";
import type { ParsedRuntimeConfig } from "../runtime-config.js";
import { postCapabilitiesChanged } from "./channel.js";
import { collectRuntimeFacts, evaluatedModuleIds } from "./facts.js";
import { installationId as readInstallationId } from "./installation.js";
import { compositionLockName } from "./keys.js";
import { type MintedLease, mintLease } from "./lease.js";
import { type LegacyReview, reviewLegacyConfiguration } from "./migration.js";
import {
  type PersistedDocs,
  readPersistedDocs,
  refreshAuthorityRecords,
  writeCommit,
  writeVaultSelection,
} from "./store-persist.js";
import {
  type BootInput,
  type CapabilityActivity,
  type CommitOutcome,
  type CompositionSnapshot,
  type EmergencyDisableOutcome,
  INITIAL_SNAPSHOT,
  durabilityOf,
  lifecycleMap,
} from "./store-types.js";

export type {
  BootInput,
  CommitOutcome,
  CompositionSnapshot,
  EmergencyDisableOutcome,
} from "./store-types.js";

type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

const MAX_DIAGNOSTICS = 32;

export const storeSeams = {
  catalog: (): Promise<CapabilityCatalog> =>
    import("./catalog.js").then((m) => m.CAPABILITY_CATALOG),
  distribution: (): Promise<DistributionContract> =>
    import("./distribution.js").then((m) => m.DISTRIBUTION),
  locks: (): LockManagerLike | undefined =>
    typeof navigator === "undefined" ? undefined : navigator.locks,
  now: (): string => new Date().toISOString(),
  installationId: (): string => readInstallationId(),
  /** S03/S04: a per-vault narrowing, when one is stored. */
  workspaceRestriction: (
    _instanceId: string,
    _vaultId: string | null,
  ): WorkspaceCapabilityRestriction | null => null,
  /** S03: envelope/revision/rollback verification of a managed policy. */
  reviewManagedPolicy: (
    _policy: InstanceCapabilityPolicy,
  ): { ok: boolean; diagnostics: readonly string[] } => ({
    ok: true,
    diagnostics: [],
  }),
};

export class CompositionStore {
  #snapshot: CompositionSnapshot = INITIAL_SNAPSHOT;
  #listeners = new Set<() => void>();
  #catalog: CapabilityCatalog | null = null;
  #distribution: DistributionContract | null = null;
  #installationId = "";
  #vaultId: string | null = null;
  #provenance: PolicyProvenance = "personal-local";
  #policy: InstanceCapabilityPolicy | null = null;
  #policyValid = true;
  #selection: InstallationCapabilitySelection | null = null;
  #receipt: ConsentReceipt | null = null;
  #vaultSelection: VaultCapabilitySelection | null = null;
  #emergencyDisabled = new Set<CapabilityId>();
  #baseFacts: RuntimeFacts | null = null;
  #committedGeneration = 0;
  #generation = 0;
  #minted: MintedLease | null = null;
  #activity = new Map<CapabilityId, CapabilityActivity>();
  #diagnostics: string[] = [];
  #legacy: LegacyReview | null = null;

  getSnapshot = (): CompositionSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The instance this installation belongs to, as the resolver derives it. */
  instanceId(): string {
    return (
      this.#snapshot.plan?.identity.instanceId ??
      this.#policy?.instanceId ??
      this.#selection?.instanceId ??
      PERSONAL_LOCAL_INSTANCE
    );
  }

  async boot(input: BootInput): Promise<void> {
    this.#catalog ??= await storeSeams.catalog();
    this.#distribution ??= await storeSeams.distribution();
    this.#installationId = storeSeams.installationId();
    this.#vaultId = input.vaultId;
    this.#baseFacts = input.facts;
    this.#diagnostics = [...input.runtimeConfig.diagnostics];
    const docs = readPersistedDocs(input.vaultId);
    this.#readPolicy(input.runtimeConfig, docs);
    this.#adopt(docs);
    this.#bump("boot");
    this.#resolve();
  }

  currentLease(): ActivationLease {
    if (!this.#minted) throw new Error("composition store has not resolved");
    return this.#minted.lease;
  }

  review(draft: InstallationCapabilitySelection): CompositionChangeReview {
    const current = this.#snapshot.plan;
    if (!current || !this.#catalog) {
      throw new Error("composition store has not resolved");
    }
    const candidate = this.#plan(draft, this.#receipt);
    return reviewCompositionChange(current, candidate, this.#catalog);
  }

  async commit(
    draft: InstallationCapabilitySelection,
    receipt: ConsentReceipt,
  ): Promise<CommitOutcome> {
    const preflight = this.#preflightCommit(draft, receipt);
    if (preflight) return preflight;
    const locks = storeSeams.locks();
    if (!locks) return { status: "refused", reason: "no-serialization" };
    try {
      return await locks.request(compositionLockName(this.instanceId()), () =>
        this.#commitLocked(draft, receipt),
      );
    } catch {
      return { status: "refused", reason: "storage" };
    }
  }

  async emergencyDisable(id: CapabilityId): Promise<EmergencyDisableOutcome> {
    this.#emergencyDisabled.add(id);
    const now = storeSeams.now();
    const next = this.#vaultSelectionWith(id, now);
    // Memory first: the next resolve no longer approves it, and the lease
    // every running part of it holds is aborted before storage is asked.
    this.#vaultSelection = next;
    this.#bump(`emergency-disable:${id}`);
    this.#resolve();
    if (this.#vaultId === null) return { blockedNow: true, durable: false };
    try {
      await writeVaultSelection(next, this.#committedGeneration + 1, now);
      this.#committedGeneration += 1;
      postCapabilitiesChanged();
      return { blockedNow: true, durable: true };
    } catch {
      this.#note(`emergency-disable:${id}: durable write failed`);
      this.#publish();
      return { blockedNow: true, durable: false };
    }
  }

  onVaultChange(vaultId: string | null): void {
    if (vaultId === this.#vaultId && this.#snapshot.plan) return;
    this.#vaultId = vaultId;
    const docs = readPersistedDocs(vaultId);
    this.#vaultSelection = this.#scopedVaultSelection(docs);
    for (const d of docs.diagnostics) this.#note(d);
    for (const id of this.#emergencyDisabled) {
      this.#vaultSelection = this.#vaultSelectionWith(id, storeSeams.now());
    }
    this.#bump(`vault:${vaultId ?? "none"}`);
    this.#resolve();
  }

  invalidate(reason: string): void {
    this.#bump(`invalidate:${reason}`);
    this.#resolve();
  }

  /** Re-read durable state after a cross-tab hint or a BFCache resume. */
  async revalidate(reason: string): Promise<void> {
    if (!this.#snapshot.plan) return;
    try {
      await refreshAuthorityRecords();
    } catch {
      this.#note(`revalidate:${reason}: storage read failed`);
      this.#snapshot = { ...this.#snapshot, status: "storage-unavailable" };
      this.invalidate(`${reason}:storage-unavailable`);
      return;
    }
    const docs = readPersistedDocs(this.#vaultId);
    if (
      docs.committedGeneration === this.#committedGeneration &&
      docs.selection?.revision === this.#selection?.revision &&
      docs.receipt?.receiptDigest === this.#receipt?.receiptDigest
    ) {
      return;
    }
    this.#adopt(docs);
    this.#bump(`external-change:${reason}`);
    this.#resolve();
  }

  /** Loader/controller report: what is loading or active in this realm. */
  setActivity(id: CapabilityId, activity: CapabilityActivity | null): void {
    if (activity === null) this.#activity.delete(id);
    else this.#activity.set(id, activity);
    this.#publish();
  }

  /** Append a human-readable diagnostic (never a secret) and publish. */
  note(message: string): void {
    this.#note(message);
    this.#publish();
  }

  /** Previously configured optional functions, offered — never enabled. */
  legacyReview(): LegacyReview {
    this.#legacy ??= reviewLegacyConfiguration();
    return this.#legacy;
  }

  /** The durable admission counter as last read or written by this tab. */
  committedGeneration(): number {
    return this.#committedGeneration;
  }

  // —— internals ————————————————————————————————————————————————

  #readPolicy(config: ParsedRuntimeConfig, docs: PersistedDocs): void {
    const section = config.capabilityComposition;
    if (config.status === "invalid") {
      this.#provenance = section ? "same-origin-deployment" : "personal-local";
      this.#policy = null;
      this.#policyValid = false;
      this.#note("runtime config invalid: core-only plan until it is fixed");
      return;
    }
    if (section?.instancePolicy) {
      const review = storeSeams.reviewManagedPolicy(section.instancePolicy);
      this.#provenance = "same-origin-deployment";
      this.#policy = section.instancePolicy;
      this.#policyValid = review.ok;
      for (const d of review.diagnostics) this.#note(d);
      return;
    }
    this.#provenance = "personal-local";
    if (docs.localPolicy.present && docs.localPolicy.policy === null) {
      this.#policy = null;
      this.#policyValid = false;
      this.#note("local policy invalid: core-only plan until it is repaired");
      return;
    }
    this.#policy = docs.localPolicy.policy;
    this.#policyValid = true;
  }

  #adopt(docs: PersistedDocs): void {
    for (const d of docs.diagnostics) this.#note(d);
    this.#selection = this.#scopedSelection(docs.selection);
    this.#receipt =
      docs.receipt && docs.receipt.installationId === this.#installationId
        ? docs.receipt
        : this.#dropped(docs.receipt, "receipt");
    this.#vaultSelection = this.#scopedVaultSelection(docs);
    this.#committedGeneration = docs.committedGeneration;
  }

  #scopedSelection(
    selection: InstallationCapabilitySelection | null,
  ): InstallationCapabilitySelection | null {
    if (!selection) return null;
    if (selection.installationId !== this.#installationId) {
      return this.#dropped(selection, "selection");
    }
    if (this.#policy && selection.instanceId !== this.#policy.instanceId) {
      return this.#dropped(selection, "selection");
    }
    return selection;
  }

  #scopedVaultSelection(docs: PersistedDocs): VaultCapabilitySelection | null {
    const v = docs.vaultSelection;
    if (!v) return null;
    return v.installationId === this.#installationId && v.vaultId === this.#vaultId
      ? v
      : this.#dropped(v, "vault selection");
  }

  #dropped<T>(doc: T | null, label: string): null {
    if (doc !== null) {
      this.#note(`${label}: scoped to another installation; ignored`);
    }
    return null;
  }

  #vaultSelectionWith(
    id: CapabilityId,
    now: string,
  ): VaultCapabilitySelection {
    const current = this.#vaultSelection;
    const disabled = current?.disabled.includes(id)
      ? current.disabled
      : [...(current?.disabled ?? []), id].sort();
    return {
      schemaVersion: 1,
      kind: "VaultCapabilitySelection",
      instanceId: this.instanceId(),
      installationId: this.#installationId,
      vaultId: this.#vaultId ?? "no-vault",
      revision: `emergency-${now}`,
      disabled,
    };
  }

  #facts(): RuntimeFacts {
    return collectRuntimeFacts({
      evaluatedModuleIds: evaluatedModuleIds(),
      activeWorkerVariant: this.#baseFacts?.activeWorkerVariant ?? null,
      now: storeSeams.now(),
    });
  }

  #plan(
    installation: InstallationCapabilitySelection | null,
    receipt: ConsentReceipt | null,
  ): EffectivePlan {
    if (!this.#catalog || !this.#distribution) {
      throw new Error("composition store has not booted");
    }
    return resolveComposition({
      catalog: this.#catalog,
      distribution: this.#distribution,
      instancePolicy: this.#policy,
      provenance: this.#provenance,
      policyValid: this.#policyValid,
      workspace: storeSeams.workspaceRestriction(this.instanceId(), this.#vaultId),
      installation,
      vault: this.#vaultSelection,
      receipt,
      facts: this.#facts(),
      installationId: this.#installationId,
      vaultId: this.#vaultId,
    });
  }

  #resolve(): void {
    const plan = this.#plan(this.#selection, this.#receipt);
    this.#minted = mintLease(plan.identity, this.#generation);
    this.#activity.clear();
    this.#snapshot = {
      status: this.#policyValid ? "ready" : "managed-invalid",
      plan,
      generation: this.#generation,
      provenance: this.#provenance,
      policy: this.#policy,
      selection: this.#selection,
      receipt: this.#receipt,
      lifecycle: lifecycleMap(plan, this.#distribution as DistributionContract, this.#activity),
      durability: durabilityOf(),
      diagnostics: [...this.#diagnostics],
    };
    this.#emit();
  }

  #publish(): void {
    const plan = this.#snapshot.plan;
    if (!plan || !this.#distribution) return;
    this.#snapshot = {
      ...this.#snapshot,
      lifecycle: lifecycleMap(plan, this.#distribution, this.#activity),
      durability: durabilityOf(),
      diagnostics: [...this.#diagnostics],
    };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  #bump(reason: string): void {
    this.#generation += 1;
    this.#minted?.abort(reason);
    this.#minted = null;
  }

  #note(message: string): void {
    this.#diagnostics.push(message);
    if (this.#diagnostics.length > MAX_DIAGNOSTICS) this.#diagnostics.shift();
  }

  #preflightCommit(
    draft: InstallationCapabilitySelection,
    receipt: ConsentReceipt,
  ): CommitOutcome | null {
    const plan = this.#snapshot.plan;
    if (!plan || !this.#catalog) return { status: "refused", reason: "not-ready" };
    if (!this.#policyValid) return { status: "refused", reason: "managed-invalid" };
    if (draft.installationId !== this.#installationId || draft.instanceId !== this.instanceId()) {
      return { status: "refused", reason: "scope-mismatch" };
    }
    if (draft.basePolicyRevision !== plan.identity.policyRevision) {
      return { status: "conflict", reason: "policy-revision" };
    }
    if (
      receipt.selectionRevision !== draft.revision ||
      receipt.installationId !== draft.installationId ||
      receipt.instanceId !== draft.instanceId ||
      receipt.policyRevision !== draft.basePolicyRevision
    ) {
      return { status: "refused", reason: "receipt-mismatch" };
    }
    if (this.#selection && draft.revision === this.#selection.revision) {
      return { status: "conflict", reason: "selection-revision" };
    }
    const delta = computeConsentDelta(this.#plan(draft, receipt), this.#catalog, receipt);
    if (
      delta.addedRoots.length > 0 ||
      delta.changedExposure.length > 0 ||
      delta.addedDependencies.length > 0
    ) {
      return { status: "refused", reason: "consent-incomplete" };
    }
    return null;
  }

  async #commitLocked(
    draft: InstallationCapabilitySelection,
    receipt: ConsentReceipt,
  ): Promise<CommitOutcome> {
    await refreshAuthorityRecords();
    const docs = readPersistedDocs(this.#vaultId);
    const persisted = this.#scopedSelection(docs.selection);
    if (
      (persisted?.revision ?? null) !== (this.#selection?.revision ?? null) ||
      docs.committedGeneration !== this.#committedGeneration
    ) {
      this.#adopt(docs);
      this.#bump("commit-conflict");
      this.#resolve();
      return { status: "conflict", reason: "generation" };
    }
    const nextGeneration = this.#committedGeneration + 1;
    try {
      await writeCommit(draft, receipt, nextGeneration, storeSeams.now());
    } catch {
      // Nothing in memory changed, so nothing is published.
      return { status: "refused", reason: "storage" };
    }
    this.#selection = draft;
    this.#receipt = receipt;
    this.#committedGeneration = nextGeneration;
    this.#bump("commit");
    this.#resolve();
    postCapabilitiesChanged();
    return {
      status: "committed",
      generation: this.#generation,
      committedGeneration: nextGeneration,
    };
  }
}

export const compositionStore = new CompositionStore();

export function useComposition(): CompositionSnapshot {
  return useSyncExternalStore(
    compositionStore.subscribe,
    compositionStore.getSnapshot,
    compositionStore.getSnapshot,
  );
}

export function useCapability(id: CapabilityId): CapabilityState | null {
  const snapshot = useComposition();
  return snapshot.plan?.capabilities[id] ?? null;
}

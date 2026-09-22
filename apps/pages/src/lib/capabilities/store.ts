/**
 * The composition store (ownership.md §4.1): one resolved plan per
 * generation, published to React through `useSyncExternalStore`, and the
 * only place a lease is minted.
 *
 * Authority moves in one direction. A draft is reviewed against the current
 * plan, committed under a Web Lock after a fresh durable read
 * (`store-commit.ts`), written durably *before* anything in memory changes,
 * and only then published with a new generation — which aborts the previous
 * lease, so every module, route and handler minted under it stops.
 * Emergency disable is the one path that changes memory first, because
 * blocking now matters more than the write.
 *
 * Nothing here decides what a document means: `resolveComposition` does.
 */

import {
  type ActivationLease,
  type CapabilityCatalog,
  type CapabilityId,
  type CompositionChangeReview,
  type ConsentReceipt,
  type DistributionContract,
  type EffectivePlan,
  type InstallationCapabilitySelection,
  resolveComposition,
} from "@opensesame/capability-composition";
import { postCapabilitiesChanged } from "./channel.js";
import { collectRuntimeFacts, evaluatedModuleIds } from "./facts.js";
import { compositionLockName } from "./keys.js";
import { type MintedLease, mintLease } from "./lease.js";
import { type LegacyReview, reviewLegacyConfiguration } from "./migration.js";
import {
  type CommitPorts,
  commitLocked,
  preflightCommit,
} from "./store-commit.js";
import {
  type StoreState,
  adoptDocs,
  initialState,
  instanceIdOf,
  readPolicy,
  scopedVaultSelection,
  vaultSelectionWith,
} from "./store-docs.js";
import {
  readPersistedDocs,
  refreshAuthorityRecords,
  writeVaultSelection,
} from "./store-persist.js";
import { reviewDraft } from "./store-review.js";
import { storeSeams } from "./store-seams.js";
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

export { storeSeams } from "./store-seams.js";

const MAX_DIAGNOSTICS = 32;

export class CompositionStore {
  #snapshot: CompositionSnapshot = INITIAL_SNAPSHOT;
  #listeners = new Set<() => void>();
  #state: StoreState = initialState();
  #minted: MintedLease | null = null;
  #activity = new Map<CapabilityId, CapabilityActivity>();
  #diagnostics: string[] = [];
  #legacy: LegacyReview | null = null;
  readonly #note = (message: string): void => {
    this.#diagnostics.push(message);
    if (this.#diagnostics.length > MAX_DIAGNOSTICS) this.#diagnostics.shift();
  };

  getSnapshot = (): CompositionSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The instance this installation belongs to, as the resolver derives it. */
  instanceId(): string {
    return instanceIdOf(this.#state, this.#snapshot.plan?.identity.instanceId);
  }

  /** The catalog this store resolves against; null before boot. */
  catalog(): CapabilityCatalog | null {
    return this.#state.catalog;
  }

  async boot(input: BootInput): Promise<void> {
    const state = this.#state;
    state.catalog ??= await storeSeams.catalog();
    state.distribution ??= await storeSeams.distribution();
    state.installationId = storeSeams.installationId();
    state.vaultId = input.vaultId;
    state.baseFacts = input.facts;
    this.#diagnostics = [...input.runtimeConfig.diagnostics];
    const docs = readPersistedDocs(input.vaultId);
    readPolicy(
      state,
      input.runtimeConfig,
      docs,
      storeSeams.reviewManagedPolicy,
      this.#note,
    );
    adoptDocs(state, docs, this.#note);
    this.#bump("boot");
    this.#resolve();
  }

  currentLease(): ActivationLease {
    if (!this.#minted) throw new Error("composition store has not resolved");
    return this.#minted.lease;
  }

  /** The plan a draft would resolve to under the current receipt; commits nothing. */
  preview(draft: InstallationCapabilitySelection): EffectivePlan {
    if (!this.#snapshot.plan)
      throw new Error("composition store has not resolved");
    return this.#plan(draft, this.#state.receipt);
  }

  /** What the draft would change (`store-review.ts`); commits nothing. */
  review(draft: InstallationCapabilitySelection): CompositionChangeReview {
    const current = this.#snapshot.plan;
    const catalog = this.#state.catalog;
    if (!current || !catalog) {
      throw new Error("composition store has not resolved");
    }
    return reviewDraft(draft, {
      current,
      catalog,
      receipt: this.#state.receipt,
      resolveWith: (installation, receipt) => this.#plan(installation, receipt),
      now: storeSeams.now,
    });
  }

  async commit(
    draft: InstallationCapabilitySelection,
    receipt: ConsentReceipt,
  ): Promise<CommitOutcome> {
    const ports = this.#commitPorts();
    const preflight = preflightCommit(ports, draft, receipt);
    if (preflight) return preflight;
    const locks = storeSeams.locks();
    if (!locks) return { status: "refused", reason: "no-serialization" };
    try {
      const outcome = await locks.request(
        compositionLockName(ports.instanceId),
        () => commitLocked(ports, draft, receipt),
      );
      if (outcome.status === "committed") postCapabilitiesChanged();
      return outcome;
    } catch {
      return { status: "refused", reason: "storage" };
    }
  }

  async emergencyDisable(id: CapabilityId): Promise<EmergencyDisableOutcome> {
    const state = this.#state;
    state.emergencyDisabled.add(id);
    const now = storeSeams.now();
    const next = vaultSelectionWith(state, this.instanceId(), id, now);
    // Memory first: the next resolve no longer approves it, and the lease
    // every running part of it holds is aborted before storage is asked.
    state.vaultSelection = next;
    this.#bump(`emergency-disable:${id}`);
    this.#resolve();
    if (state.vaultId === null) return { blockedNow: true, durable: false };
    try {
      await writeVaultSelection(next, state.committedGeneration + 1, now);
      state.committedGeneration += 1;
      postCapabilitiesChanged();
      return { blockedNow: true, durable: true };
    } catch {
      this.note(`emergency-disable:${id}: durable write failed`);
      return { blockedNow: true, durable: false };
    }
  }

  onVaultChange(vaultId: string | null): void {
    const state = this.#state;
    if (vaultId === state.vaultId && this.#snapshot.plan) return;
    state.vaultId = vaultId;
    const docs = readPersistedDocs(vaultId);
    for (const d of docs.diagnostics) this.#note(d);
    state.vaultSelection = scopedVaultSelection(state, docs, this.#note);
    for (const id of state.emergencyDisabled) {
      state.vaultSelection = vaultSelectionWith(
        state,
        this.instanceId(),
        id,
        storeSeams.now(),
      );
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
    const state = this.#state;
    try {
      await refreshAuthorityRecords();
    } catch {
      this.#note(`revalidate:${reason}: storage read failed`);
      this.#snapshot = { ...this.#snapshot, status: "storage-unavailable" };
      this.invalidate(`${reason}:storage-unavailable`);
      return;
    }
    const docs = readPersistedDocs(state.vaultId);
    if (
      docs.committedGeneration === state.committedGeneration &&
      docs.selection?.revision === state.selection?.revision &&
      docs.receipt?.receiptDigest === state.receipt?.receiptDigest
    ) {
      return;
    }
    adoptDocs(state, docs, this.#note);
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
    return this.#state.committedGeneration;
  }

  /** Test-only: back to an unbooted store (the lease, if any, is aborted). */
  resetForTest(): void {
    this.#bump("reset");
    const generation = this.#state.generation;
    this.#state = { ...initialState(), generation };
    this.#activity.clear();
    this.#diagnostics = [];
    this.#legacy = null;
    this.#snapshot = { ...INITIAL_SNAPSHOT, generation };
    this.#emit();
  }

  // —— internals ————————————————————————————————————————————————

  #commitPorts(): CommitPorts {
    return {
      state: this.#state,
      plan: this.#snapshot.plan,
      catalog: this.#state.catalog,
      instanceId: this.instanceId(),
      resolveWith: (installation, receipt) => this.#plan(installation, receipt),
      note: this.#note,
      now: storeSeams.now,
      republish: (reason) => {
        this.#bump(reason);
        this.#resolve();
      },
    };
  }

  #plan(
    installation: InstallationCapabilitySelection | null,
    receipt: ConsentReceipt | null,
  ): EffectivePlan {
    const state = this.#state;
    if (!state.catalog || !state.distribution) {
      throw new Error("composition store has not booted");
    }
    return resolveComposition({
      catalog: state.catalog,
      distribution: state.distribution,
      instancePolicy: state.policy,
      provenance: state.provenance,
      policyValid: state.policyValid,
      workspace: storeSeams.workspaceRestriction(
        this.instanceId(),
        state.vaultId,
      ),
      installation,
      vault: state.vaultSelection,
      receipt,
      facts: collectRuntimeFacts({
        evaluatedModuleIds: evaluatedModuleIds(),
        activeWorkerVariant: state.baseFacts?.activeWorkerVariant ?? null,
        now: storeSeams.now(),
      }),
      installationId: state.installationId,
      vaultId: state.vaultId,
    });
  }

  #resolve(): void {
    const state = this.#state;
    const plan = this.#plan(state.selection, state.receipt);
    this.#minted = mintLease(plan.identity, state.generation);
    this.#activity.clear();
    this.#snapshot = {
      status: state.policyValid ? "ready" : "managed-invalid",
      plan,
      generation: state.generation,
      provenance: state.provenance,
      policy: state.policy,
      selection: state.selection,
      receipt: state.receipt,
      lifecycle: lifecycleMap(
        plan,
        state.distribution as DistributionContract,
        this.#activity,
      ),
      durability: durabilityOf(),
      diagnostics: [...this.#diagnostics],
    };
    this.#emit();
  }

  #publish(): void {
    const plan = this.#snapshot.plan;
    const distribution = this.#state.distribution;
    if (!plan || !distribution) return;
    this.#snapshot = {
      ...this.#snapshot,
      lifecycle: lifecycleMap(plan, distribution, this.#activity),
      durability: durabilityOf(),
      diagnostics: [...this.#diagnostics],
    };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  #bump(reason: string): void {
    this.#state.generation += 1;
    this.#minted?.abort(reason);
    this.#minted = null;
  }
}

export const compositionStore = new CompositionStore();

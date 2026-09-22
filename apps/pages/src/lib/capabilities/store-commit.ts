/**
 * The commit path (ownership.md §4.1): preflight against the current plan,
 * then — under the instance's Web Lock — a fresh durable read, a revision
 * compare, a durable write, and only then the in-memory adoption the store
 * publishes. Nothing here touches memory before storage has accepted the
 * write; a conflict re-adopts what is on disk and the caller re-resolves.
 */

import {
  type CapabilityCatalog,
  type ConsentReceipt,
  type EffectivePlan,
  type InstallationCapabilitySelection,
  computeConsentDelta,
} from "@opensesame/capability-composition";
import { type StoreState, adoptDocs, scopedSelection } from "./store-docs.js";
import {
  readPersistedDocs,
  refreshAuthorityRecords,
  writeCommit,
} from "./store-persist.js";
import type { CommitOutcome } from "./store-types.js";

export type CommitPorts = Readonly<{
  state: StoreState;
  plan: EffectivePlan | null;
  catalog: CapabilityCatalog | null;
  instanceId: string;
  resolveWith: (
    installation: InstallationCapabilitySelection | null,
    receipt: ConsentReceipt | null,
  ) => EffectivePlan;
  note: (message: string) => void;
  now: () => string;
  /** Bump the generation, abort the lease and re-resolve after a conflict. */
  republish: (reason: string) => void;
}>;

function receiptMatches(
  draft: InstallationCapabilitySelection,
  receipt: ConsentReceipt,
): boolean {
  return (
    receipt.selectionRevision === draft.revision &&
    receipt.installationId === draft.installationId &&
    receipt.instanceId === draft.instanceId &&
    receipt.policyRevision === draft.basePolicyRevision
  );
}

/** Everything that can be refused without touching storage. */
export function preflightCommit(
  ports: CommitPorts,
  draft: InstallationCapabilitySelection,
  receipt: ConsentReceipt,
): CommitOutcome | null {
  const { state, plan, catalog } = ports;
  if (!plan || !catalog) return { status: "refused", reason: "not-ready" };
  if (!state.policyValid)
    return { status: "refused", reason: "managed-invalid" };
  if (
    draft.installationId !== state.installationId ||
    draft.instanceId !== ports.instanceId
  ) {
    return { status: "refused", reason: "scope-mismatch" };
  }
  if (draft.basePolicyRevision !== plan.identity.policyRevision) {
    return { status: "conflict", reason: "policy-revision" };
  }
  if (!receiptMatches(draft, receipt)) {
    return { status: "refused", reason: "receipt-mismatch" };
  }
  if (state.selection && draft.revision === state.selection.revision) {
    return { status: "conflict", reason: "selection-revision" };
  }
  const delta = computeConsentDelta(
    ports.resolveWith(draft, receipt),
    catalog,
    receipt,
  );
  if (
    delta.addedRoots.length > 0 ||
    delta.changedExposure.length > 0 ||
    delta.addedDependencies.length > 0
  ) {
    return { status: "refused", reason: "consent-incomplete" };
  }
  return null;
}

/** Runs under the Web Lock. Throws only when the durable *read* fails. */
export async function commitLocked(
  ports: CommitPorts,
  draft: InstallationCapabilitySelection,
  receipt: ConsentReceipt,
): Promise<CommitOutcome> {
  const { state, note } = ports;
  await refreshAuthorityRecords();
  const docs = readPersistedDocs(state.vaultId);
  const persisted = scopedSelection(state, docs.selection, note);
  if (
    (persisted?.revision ?? null) !== (state.selection?.revision ?? null) ||
    docs.committedGeneration !== state.committedGeneration
  ) {
    adoptDocs(state, docs, note);
    ports.republish("commit-conflict");
    return { status: "conflict", reason: "generation" };
  }
  const nextGeneration = state.committedGeneration + 1;
  try {
    await writeCommit(draft, receipt, nextGeneration, ports.now());
  } catch {
    // Nothing in memory changed, so nothing is published.
    return { status: "refused", reason: "storage" };
  }
  state.selection = draft;
  state.receipt = receipt;
  state.committedGeneration = nextGeneration;
  ports.republish("commit");
  return {
    status: "committed",
    generation: state.generation,
    committedGeneration: nextGeneration,
  };
}

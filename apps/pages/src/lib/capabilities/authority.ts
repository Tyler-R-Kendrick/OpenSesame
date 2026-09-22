/**
 * Operation authority (ownership.md §4.2). Two checks, two strengths:
 *
 * - `assertCurrentOperationAuthority` is synchronous and runs before any
 *   handler import: the lease must be current and the operation must be in
 *   the plan's approved set. It is the check every command path, WebMCP tool
 *   and keymap jump takes first.
 * - `admitOperation` is for the sensitive operations that must also agree
 *   with every other tab: under the instance's Web Lock it re-reads the
 *   durable generation counter and refuses when another context committed a
 *   newer plan — or when no cross-context serialization can be established.
 *   It fails closed on both.
 */

import type {
  ActivationLease,
  AdmissionDecision,
  OperationId,
} from "@opensesame/capability-composition";
import { kvRefresh } from "../kv.js";
import { GENERATION_KEY, MAX_RECORD_BYTES, compositionLockName } from "./keys.js";
import { assertLeaseCurrent, leaseIsCurrent } from "./lease.js";
import { CapabilityDenied } from "./runtime-contract.js";
import { readCommittedGeneration } from "./store-persist.js";
import { compositionStore, storeSeams } from "./store.js";

export function assertCurrentOperationAuthority(
  op: OperationId,
  lease: ActivationLease,
): void {
  const snapshot = compositionStore.getSnapshot();
  assertLeaseCurrent(lease, snapshot.generation, op);
  if (!snapshot.plan) throw new CapabilityDenied("NOT_RESOLVED", op);
  if (!snapshot.plan.approvedOperations.includes(op)) {
    throw new CapabilityDenied("NOT_APPROVED", op);
  }
}

function decision(
  admitted: boolean,
  committedGeneration: number,
  reason: AdmissionDecision["reason"],
): AdmissionDecision {
  return { admitted, committedGeneration, reason };
}

async function admitLocked(
  op: OperationId,
  lease: ActivationLease,
): Promise<AdmissionDecision> {
  const known = compositionStore.committedGeneration();
  try {
    await kvRefresh(GENERATION_KEY, MAX_RECORD_BYTES);
  } catch {
    return decision(false, known, "no-serialization");
  }
  const durable = readCommittedGeneration();
  if (durable !== known) {
    // Another context committed. Re-read everything; this caller is stale.
    void compositionStore.revalidate("admission");
    return decision(false, durable, "stale-generation");
  }
  const snapshot = compositionStore.getSnapshot();
  if (!leaseIsCurrent(lease, snapshot.generation)) {
    return decision(false, durable, "stale-generation");
  }
  if (!snapshot.plan?.approvedOperations.includes(op)) {
    return decision(false, durable, "not-approved");
  }
  return decision(true, durable, "current");
}

export async function admitOperation(
  op: OperationId,
  lease: ActivationLease,
): Promise<AdmissionDecision> {
  const known = compositionStore.committedGeneration();
  const locks = storeSeams.locks();
  if (!locks) return decision(false, known, "no-serialization");
  try {
    return await locks.request(
      compositionLockName(compositionStore.instanceId()),
      () => admitLocked(op, lease),
    );
  } catch {
    return decision(false, known, "no-serialization");
  }
}

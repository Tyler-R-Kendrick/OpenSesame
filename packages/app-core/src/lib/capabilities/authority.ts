/**
 * Operation authority (ownership.md §4.2). Two checks, two strengths:
 *
 * - `assertCurrentOperationAuthority` is synchronous and runs before any
 *   handler import: the lease must be current and the operation must be in
 *   the plan's approved set. Every WebMCP tool call takes it first
 *   (`dispatch.ts`); a command path or keymap jump, which names a
 *   destination rather than an operation, takes its capability-level twin
 *   `assertCurrentCapabilityAuthority`.
 * - `admitOperation` is for the sensitive operations — every WebMCP tool not
 *   declared read-only — that must also agree
 *   with every other tab: under the instance's Web Lock it re-reads the
 *   durable generation counter and refuses when another context committed a
 *   newer plan — or when no cross-context serialization can be established.
 *   It fails closed on both. The lock is held through the operation itself,
 *   so a commit in another context (which takes the same lock) cannot land
 *   between admission and execution. The operation must not take the
 *   instance lock again — Web Locks are not reentrant.
 */

import type {
  ActivationLease,
  AdmissionDecision,
  CapabilityId,
  OperationId,
} from "@opensesame/capability-composition";
import { kvRefresh } from "../kv.js";
import {
  GENERATION_KEY,
  MAX_RECORD_BYTES,
  compositionLockName,
} from "./keys.js";
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

/**
 * The same check for a contribution that names a destination rather than an
 * operation — a command path or a keymap jump. Its authority is the
 * capability that registered it: that capability's lease must be current and
 * the plan must still approve it. `activity.log` owns no operation and still
 * owns `/activity`; the destination exists exactly while the capability does.
 */
export function assertCurrentCapabilityAuthority(
  capability: CapabilityId,
  lease: ActivationLease,
): void {
  const snapshot = compositionStore.getSnapshot();
  assertLeaseCurrent(lease, snapshot.generation, capability);
  if (!snapshot.plan) throw new CapabilityDenied("NOT_RESOLVED", capability);
  if (!snapshot.plan.approvedCapabilities.includes(capability)) {
    throw new CapabilityDenied("NOT_APPROVED", capability);
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

export type AdmissionOutcome<T> = Readonly<{
  decision: AdmissionDecision;
  /** The operation's return value; it ran under the lock, only when admitted. */
  result: T | undefined;
}>;

export async function admitOperation<T>(
  op: OperationId,
  lease: ActivationLease,
  operation: () => T | Promise<T>,
): Promise<AdmissionOutcome<T>> {
  const known = compositionStore.committedGeneration();
  const locks = storeSeams.locks();
  if (!locks) {
    return {
      decision: decision(false, known, "no-serialization"),
      result: undefined,
    };
  }
  let operationThrew = false;
  try {
    return await locks.request(
      compositionLockName(compositionStore.instanceId()),
      async (): Promise<AdmissionOutcome<T>> => {
        const admission = await admitLocked(op, lease);
        if (!admission.admitted)
          return { decision: admission, result: undefined };
        try {
          return { decision: admission, result: await operation() };
        } catch (error) {
          operationThrew = true;
          throw error;
        }
      },
    );
  } catch (error) {
    if (operationThrew) throw error;
    return {
      decision: decision(false, known, "no-serialization"),
      result: undefined,
    };
  }
}

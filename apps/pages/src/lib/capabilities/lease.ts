/**
 * Activation leases: the authority to load and activate under one plan.
 *
 * A lease is minted for one store generation and aborted the moment that
 * generation is superseded — a commit, a lock, a vault switch, a revocation.
 * Nothing that holds a lease may act after checking it once and awaiting:
 * the check is repeated after every `await` (`assertLeaseCurrent`).
 */

import type {
  ActivationLease,
  PlanIdentity,
} from "@opensesame/capability-composition";
import { CapabilityDenied } from "./runtime-contract.js";

export type MintedLease = Readonly<{
  lease: ActivationLease;
  /** Abort the lease; idempotent. */
  abort: (reason: string) => void;
}>;

export function mintLease(
  identity: PlanIdentity,
  generation: number,
): MintedLease {
  const controller = new AbortController();
  const lease: ActivationLease = Object.freeze({
    identity,
    generation,
    signal: controller.signal,
  });
  return {
    lease,
    abort: (reason: string) => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
  };
}

/** True while the lease belongs to `currentGeneration` and was not aborted. */
export function leaseIsCurrent(
  lease: ActivationLease,
  currentGeneration: number,
): boolean {
  return !lease.signal.aborted && lease.generation === currentGeneration;
}

/** Throw `CapabilityDenied("STALE_LEASE")` unless the lease is current. */
export function assertLeaseCurrent(
  lease: ActivationLease,
  currentGeneration: number,
  subject: string,
): void {
  if (!leaseIsCurrent(lease, currentGeneration)) {
    throw new CapabilityDenied("STALE_LEASE", subject);
  }
}

/**
 * A child lease that aborts with its parent or on its own. Used to scope one
 * capability's registrations so a failed activation can be undone without
 * touching its siblings.
 */
export function deriveLease(parent: ActivationLease): MintedLease {
  const controller = new AbortController();
  const abort = (reason: string) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (parent.signal.aborted) abort("parent-aborted");
  else
    parent.signal.addEventListener("abort", () => abort("parent-aborted"), {
      once: true,
    });
  const lease: ActivationLease = Object.freeze({
    identity: parent.identity,
    generation: parent.generation,
    signal: controller.signal,
  });
  return { lease, abort };
}

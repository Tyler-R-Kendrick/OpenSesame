/**
 * The change coordinator (ownership.md §3, S19): the one controller that
 * turns a resolved plan into running code and a superseded plan into
 * disposed code.
 *
 * It follows the store. When the generation moves it first deactivates the
 * previous generation — handles disposed, registrations revoked — and only
 * then activates every approved modular capability under the new lease,
 * one at a time, re-checking the lease between each. Transitions are
 * serialized on one promise chain so a burst of bumps cannot interleave an
 * activation with the disposal that should have preceded it.
 */

import type {
  CapabilityId,
  EffectivePlan,
} from "@opensesame/capability-composition";
import { vaultStore } from "../vault/store.js";
import { vaultIdOf } from "./invalidation.js";
import { leaseIsCurrent } from "./lease.js";
import {
  activateApprovedCapability,
  deactivateGeneration,
  loaderSeams,
} from "./loader.js";
import { contributions } from "./registry.js";
import { isCapabilityDenied } from "./runtime-contract.js";
import type { CompositionStore } from "./store.js";

/**
 * Approved capabilities the loader has to activate: every one that owns a
 * page module in this plan — the optional tier and the always-on core
 * (`alwaysOn` in `descriptor.ts`). Always-on first, so the functions every
 * installation has arrive before the ones it chose. A core capability with
 * no module is statically linked and has nothing to activate.
 */
export function modularApproved(plan: EffectivePlan): CapabilityId[] {
  const owns = (id: CapabilityId) =>
    plan.approvedModules.some(
      (module) => module.startsWith(`${id}/`) && !module.endsWith("/worker"),
    );
  const approved = plan.approvedCapabilities.filter(owns);
  const tier = (id: CapabilityId) => plan.capabilities[id]?.tier;
  return [
    ...approved.filter((id) => tier(id) === "core"),
    ...approved.filter((id) => tier(id) !== "core"),
  ];
}

function readVaultContext(): { tomb: string | null; guest: boolean } {
  const state = vaultStore.getSnapshot();
  return { tomb: vaultIdOf(state), guest: state.guest };
}

const startedJobs = new WeakSet<object>();

function startBackgroundJobs(signal: AbortSignal): void {
  for (const job of contributions("background-job")) {
    if (startedJobs.has(job)) continue;
    startedJobs.add(job);
    try {
      job.start(signal);
    } catch {
      // A job that throws on start is a job that did not start.
    }
  }
}

export const changeSeams = {
  activateApprovedCapability,
  deactivateGeneration,
};

/**
 * Drive activation for the store's current lease and deactivation on every
 * generation bump. Returns a stop function that disposes the last generation.
 */
export function activatePlan(store: CompositionStore): () => void {
  let activeGeneration = -1;
  let stopped = false;
  let queue: Promise<void> = Promise.resolve();
  loaderSeams.vaultContext = readVaultContext;

  const transition = async (generation: number, previous: number) => {
    if (previous >= 0) await changeSeams.deactivateGeneration(previous);
    if (stopped || store.getSnapshot().generation !== generation) return;
    const plan = store.getSnapshot().plan;
    if (!plan) return;
    const lease = store.currentLease();
    for (const id of modularApproved(plan)) {
      if (!leaseIsCurrent(lease, store.getSnapshot().generation)) return;
      try {
        await changeSeams.activateApprovedCapability(id, lease);
      } catch (error) {
        store.note(
          `activate ${id}: ${isCapabilityDenied(error) ? error.code : "failed"}`,
        );
      }
    }
    if (leaseIsCurrent(lease, store.getSnapshot().generation)) {
      startBackgroundJobs(lease.signal);
    }
  };

  const follow = () => {
    const snapshot = store.getSnapshot();
    if (stopped || !snapshot.plan || snapshot.generation === activeGeneration)
      return;
    const previous = activeGeneration;
    activeGeneration = snapshot.generation;
    queue = queue
      .then(() => transition(snapshot.generation, previous))
      .catch(() => undefined);
  };

  const unsubscribe = store.subscribe(follow);
  follow();
  return () => {
    stopped = true;
    unsubscribe();
    const last = activeGeneration;
    activeGeneration = -1;
    if (last >= 0)
      queue = queue.then(() => changeSeams.deactivateGeneration(last));
  };
}

/**
 * Plan-scoped bootstrap: activation leases minted against plan identity.
 *
 * A lease binds a module to the (planDigest, generation) that admitted it.
 * Generation is monotonic per bootstrap; a lease expires when a newer plan
 * supersedes its generation. The dispatch gate refuses anything whose
 * lease is stale or revoked. No wall clock, no timers — expiry is plan
 * succession, per the lifecycle contract.
 */
import type {
  DispatchGate,
  ModuleActivationLease,
  ModuleId,
} from "@opensesame/capability-composition";

export type LeaseStore = {
  /** Mint a lease for a module against the current generation. */
  mint(moduleId: ModuleId, planDigest: string): ModuleActivationLease;
  /** Revoke a module's lease; idempotent. */
  revoke(moduleId: ModuleId): void;
  /** Advance to a new plan generation; expires older leases. */
  supersede(planDigest: string): number;
  /** True when the module holds a live lease for the current plan. */
  live(moduleId: ModuleId): boolean;
  /** The dispatch gate bound to this store. */
  gate(): DispatchGate;
};

/** Create a lease store starting at generation 1. */
export function createLeaseStore(): LeaseStore {
  let generation = 1;
  let planDigest = "";
  const revoked = new Set<string>();
  const minted = new Map<string, number>();
  return {
    mint(moduleId, digest) {
      planDigest = digest;
      revoked.delete(moduleId);
      minted.set(moduleId, generation);
      return {
        moduleId,
        planDigest: digest,
        generation,
        expiresAtKind: "plan-generation",
      };
    },
    revoke(moduleId) {
      revoked.add(moduleId);
    },
    supersede(digest) {
      planDigest = digest;
      generation += 1;
      return generation;
    },
    live(moduleId) {
      if (revoked.has(moduleId)) return false;
      return minted.get(moduleId) === generation;
    },
    gate() {
      return {
        allows: (moduleId, digest) =>
          digest === planDigest &&
          !revoked.has(moduleId) &&
          minted.get(moduleId) === generation,
        refusalReason: (moduleId) =>
          revoked.has(moduleId)
            ? `${moduleId} lease revoked`
            : `${moduleId} has no live lease for this plan`,
      };
    },
  };
}

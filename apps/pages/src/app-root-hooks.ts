/**
 * The app root's capability and unlock lifecycle hooks, split out for the
 * file budget: approval state, unlock effects, and the initial vault route.
 */

import type { UnlockEffectContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { clearActivePresentation } from "@opensesame/app-core/lib/duress/compartment/presentation-runtime.js";
import {
  syncRotationSchedules,
  tickRotationSchedules,
} from "@opensesame/app-core/lib/vault/rotation-queue.js";
import { processRotationQueue } from "@opensesame/app-core/lib/vault/rotation-relay.js";
import type { VaultItem } from "@opensesame/vault-core";
import { useEffect } from "react";
import type { NavigateFunction } from "react-router";
import { useComposition } from "./bindings/capabilities.js";

export function useCapabilityGate(id: string) {
  const snapshot = useComposition();
  const state = snapshot.plan?.capabilities[id] ?? null;
  return {
    approved: state?.approved === true,
    lifecycle: snapshot.lifecycle[id] ?? null,
    state,
  };
}

/**
 * Unlock effects an approved module registered run once per unlock, under
 * the lease that approved them: a bump aborts the signal they were handed.
 *
 * Locking clears any active duress presentation first (ADR 0131). That is
 * core, not an unlock effect: it must run whether or not a tomb is open and
 * whether or not a capability contributed anything, so it sits ahead of the
 * early return rather than inside the effect list.
 */
export function useAfterUnlock(
  status: string,
  tomb: string | undefined,
  guest: boolean | undefined,
  effects: readonly UnlockEffectContribution[],
  recover: () => void,
): void {
  useEffect(() => {
    if (status !== "unlocked") {
      clearActivePresentation();
      return;
    }
    if (!tomb) return;
    recover();
    const controller = new AbortController();
    let leaseSignal: AbortSignal | null = null;
    try {
      leaseSignal = compositionStore.currentLease().signal;
    } catch {
      // Not resolved yet: the effects run again on the next generation.
    }
    const onLeaseAbort = () => controller.abort("lease");
    leaseSignal?.addEventListener("abort", onLeaseAbort, { once: true });
    for (const effect of effects) {
      void effect
        .run({ tomb, guest: guest === true, signal: controller.signal })
        .catch(() => undefined);
    }
    return () => {
      leaseSignal?.removeEventListener("abort", onLeaseAbort);
      controller.abort("unmount");
    };
  }, [status, tomb, guest, effects, recover]);
}

/**
 * Land on the vault before the shell mounts: the rail's sections open from
 * the route they first render under, and mounting on "/" would leave every
 * one of them closed.
 */
export function useVaultLanding(
  status: string,
  pathname: string,
  navigate: NavigateFunction,
): void {
  useEffect(() => {
    if (status === "unlocked" && pathname === "/")
      navigate("/vault", { replace: true });
  }, [pathname, navigate, status]);
}

/** Queue due rotations at app open, and drain the active vault's queue on unlock. */
export function useRotationQueue(
  status: string,
  tomb: string | undefined,
  items: readonly VaultItem[] | undefined,
): void {
  useEffect(() => {
    // A due schedule is visible while the vault is locked. Opening the page
    // is the listener: queue what is due, then leave it for the next unlock.
    void tickRotationSchedules();
  }, []);
  useEffect(() => {
    if (status !== "unlocked" || !tomb) return;
    if (!Array.isArray(items)) return;
    syncRotationSchedules(items, tomb);
    void processRotationQueue(tomb);
  }, [status, tomb, items]);
}

export type VaultStatus = {
  status: string;
  tomb?: string;
  guest?: boolean;
  items?: readonly VaultItem[];
};

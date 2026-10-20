/**
 * The app root's two capability hooks, split out for the file budget:
 * whether one capability is approved, and what runs after each unlock.
 */

import type { UnlockEffectContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { clearActivePresentation } from "@opensesame/app-core/lib/duress/compartment/presentation-runtime.js";
import { useEffect } from "react";
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

/**
 * Cross-context invalidation (ownership.md §3, S19).
 *
 * The store's generation must move whenever authority may have changed
 * somewhere this tab cannot see: another tab committed (BroadcastChannel
 * hint, content ignored), this document came back from the back/forward
 * cache or from the background (re-read the durable counter), the vault
 * locked, or the session moved to another tomb. Every path here re-reads
 * durable state and lets the store decide; none of them carries a plan.
 */

import { maybePage } from "../../ports.js";
import { kvHydrate } from "../kv.js";
import { onVaultLock } from "../vault/lock-events.js";
import { type VaultState, vaultStore } from "../vault/store.js";
import { subscribeCapabilitiesChanged } from "./channel.js";
import { vaultSelectionKey } from "./keys.js";
import type { CompositionStore } from "./store.js";

/** The tomb whose plan applies: the unlocked one, or none. */
export function vaultIdOf(state: VaultState): string | null {
  return state.status === "unlocked" ? state.tomb : null;
}

async function switchVault(
  store: CompositionStore,
  vaultId: string | null,
): Promise<void> {
  if (vaultId !== null) {
    try {
      await kvHydrate([vaultSelectionKey(vaultId)]);
    } catch {
      // The store reads what is in memory; an unreadable disable list is
      // reported there as absent, and emergency disables stay in memory.
    }
  }
  store.onVaultChange(vaultId);
}

export const invalidationSeams = {
  vaultStore: () => vaultStore,
  onVaultLock,
  subscribeCapabilitiesChanged,
};

/** Start watching; returns a stop function. Idempotent per call pair. */
export function startInvalidationWatch(store: CompositionStore): () => void {
  const stops: Array<() => void> = [];
  stops.push(
    invalidationSeams.subscribeCapabilitiesChanged(() => {
      void store.revalidate("broadcast-hint");
    }),
  );
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) void store.revalidate("bfcache-resume");
  };
  // A host with no page has no bfcache and no visibility to watch.
  const current = maybePage();
  if (current) {
    current.addEventListener("pageshow", onPageShow);
    stops.push(() => current.removeEventListener("pageshow", onPageShow));
    stops.push(
      current.onVisibilityChange(() => {
        if (current.visibilityState === "visible")
          void store.revalidate("visible");
      }),
    );
  }

  const vault = invalidationSeams.vaultStore();
  let lastVault = vaultIdOf(vault.getSnapshot());
  stops.push(
    vault.subscribe(() => {
      const next = vaultIdOf(vault.getSnapshot());
      if (next === lastVault) return;
      lastVault = next;
      void switchVault(store, next);
    }),
  );
  stops.push(
    invalidationSeams.onVaultLock(() => store.invalidate("vault-lock")),
  );

  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}

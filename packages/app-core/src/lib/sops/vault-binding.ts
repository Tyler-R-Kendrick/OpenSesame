/**
 * Wire the SOPS session to the vault store's real lifecycle (RUNTIME-03):
 * `onLock` covers lock, auto-lock, logout, and guest exit (every exit goes
 * through `lock()`), and a snapshot whose tomb or unlocked state changes
 * covers a vault switch and a session that ended without the lock hook.
 */

import type { VaultState } from "../vault/store.js";
import {
  type SopsLifecycleSource,
  type SopsSession,
  bindSopsSession,
} from "./session.js";

export type VaultLifecycleStore = {
  onLock(handler: () => void): () => void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): Pick<VaultState, "tomb" | "status" | "guest">;
};

export function vaultLifecycleSource(
  store: VaultLifecycleStore,
): SopsLifecycleSource {
  return {
    activeScope: () => {
      const snapshot = store.getSnapshot();
      return snapshot.status === "unlocked" ? snapshot.tomb : null;
    },
    onSessionChange: (handler) => {
      let last = store.getSnapshot();
      const offLock = store.onLock(handler);
      const offChange = store.subscribe(() => {
        const next = store.getSnapshot();
        const switched = next.tomb !== last.tomb || next.guest !== last.guest;
        const ended = last.status === "unlocked" && next.status !== "unlocked";
        last = next;
        if (switched || ended) handler();
      });
      return () => {
        offLock();
        offChange();
      };
    },
  };
}

let bound: (() => void) | null = null;

/** Bind once for the application; idempotent. */
export function bindSopsSessionToVault(
  session: SopsSession,
  store: VaultLifecycleStore,
): () => void {
  if (bound) return bound;
  bound = bindSopsSession(session, vaultLifecycleSource(store));
  const unbind = bound;
  return () => {
    unbind();
    if (bound === unbind) bound = null;
  };
}

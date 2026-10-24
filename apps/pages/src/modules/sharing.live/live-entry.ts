/**
 * The first arrival after joining should land in the joiner's own vault.
 * Joining can finish before the ask call returns, so the handoff is observable
 * rather than a plain module flag: a later request must still wake the joined
 * screen. Returning to /live later must not bounce back, so the handoff is
 * consumed once.
 */
import { useSyncExternalStore } from "react";

let pending = false;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export function requestVaultEntry(): void {
  if (pending) return;
  pending = true;
  changed();
}

export function takeVaultEntry(): boolean {
  if (!pending) return false;
  pending = false;
  changed();
  return true;
}

export function cancelVaultEntry(): void {
  if (!pending) return;
  pending = false;
  changed();
}

export function useVaultEntryPending(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
  );
}

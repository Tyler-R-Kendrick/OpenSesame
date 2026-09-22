/**
 * In-session presentation state after a matched duress unlock (COMPARTMENT-UX → STORE).
 * Never holds the protected vault root — only admitted compartment material.
 */

import type { OpenOutcome } from "./session.js";
import type { ScopedView } from "./scope.js";

export type ActivePresentation = Readonly<{
  profileId: string;
  outcome: OpenOutcome;
  view: ScopedView;
}>;

let active: ActivePresentation | null = null;
const listeners = new Set<() => void>();

export function readActivePresentation(): ActivePresentation | null {
  return active;
}

export function setActivePresentation(next: ActivePresentation | null): void {
  active = next;
  for (const listener of listeners) listener();
}

export function clearActivePresentation(): void {
  setActivePresentation(null);
}

export function subscribeActivePresentation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

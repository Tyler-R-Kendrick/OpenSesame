/**
 * The directory's panels, as `enterprise.directory-provisioning` hands them
 * to the Identity section.
 *
 * The section is `identity.local-iam`'s and always on (ADR 0142); People,
 * Agents and the directory's device approval are the directory's, and an
 * installation without it must not carry their code. So the section never
 * imports them: the directory's runtime puts them here in `activate` and
 * takes them back in `dispose`, beside the tabs it contributes
 * (`identity-views.ts`). Until then the slot is empty and nothing is drawn.
 */

import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import { type ComponentType, useSyncExternalStore } from "react";

export type DirectoryPanels = {
  readonly People: ComponentType<{ online: boolean }>;
  readonly Agents: ComponentType<{ online: boolean }>;
  readonly Devices: ComponentType<{
    online: boolean;
    session: IdentitySession | null;
  }>;
};

let current: DirectoryPanels | null = null;
const listeners = new Set<() => void>();

function publish(next: DirectoryPanels | null): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

/** Put the directory's panels in the section. Returns the revoke. */
export function contributeDirectoryPanels(panels: DirectoryPanels): () => void {
  publish(panels);
  return () => {
    if (current === panels) publish(null);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The panels the directory put here, or null while it is not running. */
export function currentDirectoryPanels(): DirectoryPanels | null {
  return current;
}

export function useDirectoryPanels(): DirectoryPanels | null {
  return useSyncExternalStore(subscribe, currentDirectoryPanels);
}

/**
 * The tailnet device manager, as `networking.tailnet-devices` hands it to the
 * Identity section (ADR 0169).
 *
 * The section is always on; managing a tailnet's machines is optional and
 * consented to on its own (ADR 0130), so the section never imports that
 * code. The capability's runtime puts its panels here in `activate` and takes
 * them back in `dispose`; until then the slot is empty and Devices draws the
 * browser list alone.
 */

import { type ComponentType, useSyncExternalStore } from "react";

let current: ComponentType | null = null;
const listeners = new Set<() => void>();

function publish(next: ComponentType | null): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

/** Put the tailnet device panels in Identity › Devices. Returns the revoke. */
export function contributeTailnetDevices(panels: ComponentType): () => void {
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

export function currentTailnetDevices(): ComponentType | null {
  return current;
}

export function useTailnetDevices(): ComponentType | null {
  return useSyncExternalStore(subscribe, currentTailnetDevices);
}

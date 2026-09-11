import { useSyncExternalStore } from "react";

/**
 * Keyboard cursor in the rail, independent of the route.
 *
 * Up from the first child of an open directory must land on that directory
 * even when the URL still names the child (section roots rewrite to a default
 * view). Leaf clicks clear this; a directory click keeps the cursor on that
 * row so Left/Right still target it.
 */

let cursorId: string | null = null;
const listeners = new Set<() => void>();

export function setRailCursor(id: string | null): void {
  if (cursorId === id) return;
  cursorId = id;
  for (const notify of listeners) notify();
}

export function useRailCursor(): string | null {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => cursorId,
    () => null,
  );
}

import { type RefObject, useEffect, useSyncExternalStore } from "react";

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

/**
 * Drop the cursor when the page moves without the rail: a jump key, a link
 * in the page, the browser's back button. The cursor is the rail's own
 * keyboard position; left on the row it last touched, it drew that row as
 * the selected one (Settings › Danger, black) over whatever page came next.
 */
export function useRailCursorFollowsRoute(
  treeRef: RefObject<HTMLElement | null>,
  route: string,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `route` is the trigger; the effect reads focus, not the route
  useEffect(() => {
    const tree = treeRef.current;
    if (tree?.contains(document.activeElement)) return;
    setRailCursor(null);
  }, [route, treeRef]);
}

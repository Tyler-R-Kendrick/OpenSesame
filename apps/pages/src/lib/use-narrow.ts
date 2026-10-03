import { useSyncExternalStore } from "react";

/**
 * The width below which the shell draws one pane at a time. It is the same
 * 900px the stylesheet breaks on (`styles.css`, `vault.css`): the rail goes,
 * and what the rail carried has to be drawn somewhere a finger can reach.
 */
export const NARROW_QUERY = "(max-width: 900px)";

function query(): MediaQueryList | null {
  if (globalThis.window === undefined) return null;
  try {
    return window.matchMedia?.(NARROW_QUERY) ?? null;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  list?.addEventListener("change", onChange);
  return () => list?.removeEventListener("change", onChange);
}

/**
 * True while the shell is below the one-pane breakpoint. A browser with no
 * `matchMedia` is drawn as a desktop: the rail is the frame that is always
 * complete, and the phone arrangement only exists where the width says so.
 */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => query()?.matches === true,
    () => false,
  );
}

import { useSyncExternalStore } from "react";

const COARSE_QUERY = "(pointer: coarse)";

function query(): MediaQueryList | null {
  if (globalThis.window === undefined) return null;
  try {
    return window.matchMedia?.(COARSE_QUERY) ?? null;
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
 * True while the primary pointer is a finger. For copy that lives in an
 * attribute (a placeholder) or a string a script builds, where the CSS pair
 * `.…--keys` / `.…-touch` cannot reach. A browser with no `matchMedia` is
 * drawn as a desktop, as `isTouchPointer` does.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => query()?.matches === true,
    () => false,
  );
}

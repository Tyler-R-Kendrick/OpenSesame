import { useSyncExternalStore } from "react";
import { COARSE_POINTER_QUERY } from "../lib/gestures.js";

function query(): MediaQueryList | null {
  if (globalThis.window === undefined) return null;
  try {
    return window.matchMedia?.(COARSE_POINTER_QUERY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Safari before 14 has a MediaQueryList with only the old `addListener`, and
 * a test renderer may hand back a bare object: neither may throw in commit.
 */
function subscribe(onChange: () => void): () => void {
  // Read as optional members: a browser may have either pair, or neither.
  const list: Partial<MediaQueryList> | null = query();
  if (list === null) return () => undefined;
  if (list.addEventListener) {
    list.addEventListener("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  }
  list.addListener?.(onChange);
  return () => list.removeListener?.(onChange);
}

/**
 * True while the primary pointer is a finger. For copy that lives in an
 * attribute (a placeholder) or a string a script builds, where the CSS pair
 * `.…--keys` / `.…-touch` cannot reach. It reads the same query as
 * `isTouchPointer` (`COARSE_POINTER_QUERY`), and a browser with no
 * `matchMedia` is drawn as a desktop, as that does.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => query()?.matches === true,
    () => false,
  );
}

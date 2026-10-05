import { useSyncExternalStore } from "react";

/**
 * The width below which the shell draws one pane at a time. It is the same
 * 900px the stylesheet breaks on (`styles.css`, `vault.css`): the rail goes,
 * and what the rail carried has to be drawn somewhere a finger can reach.
 */
export const NARROW_QUERY = "(max-width: 900px)";

/** True while any attached pointer is precise: a mouse, a trackpad, a pen. */
export const FINE_POINTER_QUERY = "(any-pointer: fine)";

function list(media: string): MediaQueryList | null {
  if (globalThis.window === undefined) return null;
  try {
    return window.matchMedia?.(media) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a media query holds. `absent` is the answer where there is no
 * `matchMedia` to ask (a test renderer, a server): each caller says which way
 * its page is drawn when nothing can be measured.
 */
export function useMediaQuery(media: string, absent: boolean): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const found = list(media);
      found?.addEventListener("change", onChange);
      return () => found?.removeEventListener("change", onChange);
    },
    () => list(media)?.matches ?? absent,
    () => absent,
  );
}

/** Whether the shell is below the one-pane breakpoint right now, off any render. */
export function narrowNow(): boolean {
  return list(NARROW_QUERY)?.matches ?? false;
}

/** Whether a precise pointer is attached right now, off any render. */
export function finePointerNow(): boolean {
  return list(FINE_POINTER_QUERY)?.matches ?? true;
}

/**
 * True while the shell is below the one-pane breakpoint. A browser with no
 * `matchMedia` is drawn as a desktop: the rail is the frame that is always
 * complete, and the phone arrangement only exists where the width says so.
 */
export function useNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY, false);
}

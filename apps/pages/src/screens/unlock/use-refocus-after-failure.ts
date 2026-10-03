import {
  type MutableRefObject,
  type RefObject,
  useEffect,
  useRef,
} from "react";

export type PendingFocus =
  MutableRefObject<RefObject<HTMLElement | null> | null>;

/**
 * Put the caret back after a failed attempt, once the field can take it.
 *
 * The field is disabled while the attempt is in flight, `focus()` on a disabled
 * control does nothing, and a browser drops focus from a control the moment it
 * is disabled. A failure therefore asks for focus (`pending.current = ref`) and
 * this effect grants it after the render that cleared `busy` — and any lockout
 * the miss started — has re-enabled the form, rather than guessing how long
 * React takes with a timer.
 */
export function useRefocusAfterFailure(
  busy: boolean,
  gated: boolean,
): PendingFocus {
  const pending: PendingFocus = useRef(null);
  useEffect(() => {
    if (busy || gated) return;
    const target = pending.current?.current;
    pending.current = null;
    target?.focus();
  }, [busy, gated]);
  return pending;
}

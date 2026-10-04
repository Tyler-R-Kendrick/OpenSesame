import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { useEffect, useRef } from "react";

export interface FailureNoticeOptions {
  /**
   * Any value whose identity changes with each new failure. The effect runs
   * again when it changes, so an identical sentence raised after the person
   * dismissed the notice comes back instead of being swallowed as "unchanged".
   */
  occurrence?: unknown;
  /**
   * Take the notice with the component. For an inline outcome (`StatusNote`)
   * that its caller mounts only while a message exists: unmounting is how it
   * says the outcome is gone. Off by default — a failure outlives its screen.
   */
  clearOnUnmount?: boolean;
}

/**
 * A failure belongs in the notifications tray, never in a red box inside the
 * screen (DESIGN.md § Status is a symbol, `docs/design/controls.md` § 0).
 *
 * Give this the sentence a screen would have painted and it keeps one notice
 * in the tray under `id`: a new sentence replaces the old one, an emptied
 * sentence clears it, and a changed `id` takes the previous id's notice with
 * it. A notice outlives the screen that raised it — leaving the page does not
 * make the failure go away — so nothing is dismissed on unmount unless the
 * caller asks (`clearOnUnmount`). Only a failure that clears while its screen
 * is still here (the retry worked) takes its notice with it.
 */
export function useFailureNotice(
  id: string,
  title: string,
  message: string | null | undefined,
  tone: "warn" | "err" = "err",
  options: FailureNoticeOptions = {},
): void {
  const { occurrence, clearOnUnmount = false } = options;
  const raisedId = useRef<string | null>(null);
  const lastOccurrence = useRef<unknown>(undefined);
  const clearOnUnmountRef = useRef(clearOnUnmount);
  clearOnUnmountRef.current = clearOnUnmount;
  useEffect(() => {
    // `occurrence` is a dependency so a new identity re-raises; recording it
    // is the one thing the effect does with it.
    lastOccurrence.current = occurrence;
    const previous = raisedId.current;
    if (previous !== null && previous !== id) {
      dismissNotice(previous);
      raisedId.current = null;
    }
    if (message) {
      raisedId.current = id;
      setStatusNotice({ id, tone, title, body: message });
    } else if (raisedId.current === id) {
      raisedId.current = null;
      dismissNotice(id);
    }
  }, [id, title, message, tone, occurrence]);

  useEffect(
    () => () => {
      if (!clearOnUnmountRef.current || raisedId.current === null) return;
      dismissNotice(raisedId.current);
      raisedId.current = null;
    },
    [],
  );
}

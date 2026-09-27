/**
 * Focus a control once a change has landed.
 *
 * A confirmed delete, removal, claim or bind can take the key that had focus
 * away with its row or its form, which drops focus on <body> — the next Tab
 * then starts from the top of the page. A panel names the control to land on
 * instead (its add key, the claimed row's edit key, the row's Bind), and this
 * puts focus there once React has committed the render that settles the
 * change and the panel is no longer busy, so the control exists and is
 * enabled when it is focused. A timer or an animation frame cannot promise
 * either: under load it fires before the commit and finds nothing to focus.
 *
 * It only ever recovers lost focus. If the person has already moved on —
 * into a field, onto another key — while the change was in flight, focus
 * stays where they put it (AGENTS.md: never steal focus from an active user).
 */

import { useCallback, useEffect, useState } from "react";
import { keyboardIsIdle, landFocus } from "./focus.js";

/** Where to land, asked only once the change has settled: a row's key may have left with its row. */
export type FocusTarget = () => Element | null | undefined;

/** The control with `id`, looked up when the change settles. */
export function byId(id: string): FocusTarget {
  return () => document.getElementById(id);
}

export function useFocusAfter(busy: boolean): (target: FocusTarget) => void {
  // Boxed, so the lookup is stored rather than called as a state updater.
  const [pending, setPending] = useState<{ to: FocusTarget } | null>(null);
  useEffect(() => {
    if (busy || !pending) return;
    setPending(null);
    if (keyboardIsIdle()) landFocus(pending.to());
  }, [busy, pending]);
  return useCallback((to: FocusTarget) => setPending({ to }), []);
}

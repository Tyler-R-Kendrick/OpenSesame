/**
 * Where the keyboard lands when a live-session screen swaps one state for
 * another (AGENTS.md §5).
 *
 * Asking replaces the form with the request code, Connect replaces the reply
 * field with the joined view, Start replaces the form with the live session,
 * and End puts it back: each takes the control that held the keyboard out of
 * the document, and the next Tab would begin at the top of the page. These
 * two hooks hand the keyboard to the new state — but only when it was lost.
 * Someone who has already moved on, by mouse, touch or another key, keeps
 * the focus they chose.
 */

import { useEffect, useRef } from "react";
import { keyboardIsIdle, landFocus } from "../../lib/focus.js";
import { revealClear } from "./live-reveal.js";

/** Where to land, asked once the change has rendered: the new state's own node. */
export type LandAt = () => Element | null | undefined;

/**
 * True when nothing usable holds the keyboard: `<body>`, a node that left the
 * document, or a control a busy form has disabled (browsers drop focus from
 * one at different moments, so it counts as lost before they do).
 */
export function stranded(): boolean {
  if (keyboardIsIdle()) return true;
  const held = document.activeElement;
  return (
    (held instanceof HTMLButtonElement ||
      held instanceof HTMLInputElement ||
      held instanceof HTMLSelectElement ||
      held instanceof HTMLTextAreaElement) &&
    held.disabled
  );
}

/**
 * Land on `target` and leave it where it can be seen. `landFocus` does not
 * scroll, and these swaps replace a tall form with a shorter view, so the
 * pane's scroll position is clamped and the control that now holds the
 * keyboard can end up under the page's sticky strip or off the pane's edge.
 */
function land(target: Element | null | undefined): void {
  if (landFocus(target) && target) revealClear(target);
}

/**
 * Land on `at()` when `phase` changes and the keyboard was lost with the old
 * state. The first render is an arrival, which the frame around the screen
 * already owns.
 */
export function useLandOnChange(phase: string, at: LandAt): void {
  const seen = useRef(phase);
  const target = useRef(at);
  target.current = at;
  useEffect(() => {
    if (seen.current === phase) return;
    seen.current = phase;
    if (stranded()) land(target.current());
  }, [phase]);
}

/**
 * Land on `at()` when a busy form settles and the keyboard was lost while
 * its fields were disabled: the field that carries the answer, or the key
 * that tries again.
 */
export function useLandWhenSettled(busy: boolean, at: LandAt): void {
  const was = useRef(busy);
  const target = useRef(at);
  target.current = at;
  useEffect(() => {
    const settled = was.current && !busy;
    was.current = busy;
    if (settled && stranded()) land(target.current());
  }, [busy]);
}

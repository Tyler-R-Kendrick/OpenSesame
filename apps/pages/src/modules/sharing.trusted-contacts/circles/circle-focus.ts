/**
 * Where the keyboard lands when a step of a circle ceremony swaps what is
 * drawn (AGENTS.md §5). Making the invitation takes the Name form out of the
 * sheet, and with it the key that was pressed; the next Tab would begin at
 * the top of the page. These hand the keyboard to the new step, but only when
 * it was lost: someone who has already moved on keeps the focus they chose.
 */

import { type RefObject, useEffect, useRef } from "react";
import { firstControl, keyboardIsIdle, landFocus } from "../../../lib/focus.js";

/** True when nothing usable holds the keyboard: the body, a node that left, or a control that is switched off. */
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

function land(target: Element | null | undefined): void {
  if (landFocus(target)) target?.scrollIntoView?.({ block: "nearest" });
}

/** Land on the first control of `region` when `phase` changes and the keyboard was lost with the old state. */
export function useLandOnChange(
  phase: string,
  region: RefObject<HTMLElement | null>,
): void {
  const seen = useRef(phase);
  useEffect(() => {
    if (seen.current === phase) return;
    seen.current = phase;
    if (stranded()) land(firstControl(region.current));
  }, [phase, region]);
}

/** Land on `id` when a list changes (a contact removed takes its key with it) and the keyboard was lost. */
export function landOnId(id: string): void {
  if (stranded()) land(document.getElementById(id));
}

/** Land on `id` when `phase` changes (a contact removed takes its key with it) and the keyboard was lost. */
export function useLandOnIdAfter(phase: string, id: string): void {
  const seen = useRef(phase);
  useEffect(() => {
    if (seen.current === phase) return;
    seen.current = phase;
    landOnId(id);
  }, [phase, id]);
}

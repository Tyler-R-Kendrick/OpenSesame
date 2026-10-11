/**
 * Where the keyboard lands when a guardian's sheet swaps one state for another
 * (AGENTS.md §5). Reading an invitation replaces the paste field with the
 * agreement, approving replaces the Approve key with the approval to copy:
 * each takes the control that held the keyboard out of the document, and the
 * next Tab would start at the top of the page.
 *
 * These hand the keyboard to the new state, but only when it was lost. Someone
 * who has already moved on, by mouse, touch or another key, keeps the focus
 * they chose.
 */

import { useEffect, useRef } from "react";
import { keyboardIsIdle, landFocus } from "../../../lib/focus.js";

/** Where to land, asked once the change has rendered: the new state's own node. */
export type LandAt = () => Element | null | undefined;

/**
 * True when nothing usable holds the keyboard: `<body>`, a node that left the
 * document, or a control a busy form has disabled (browsers drop focus from
 * one at different moments, so it counts as lost before they do).
 */
function stranded(): boolean {
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

/** The sheet's own close key, the one control every state of it has. */
export function closeKeyOf(inside: Element | null): Element | null {
  return (
    inside?.closest(".sheet")?.querySelector(".sheet__head button") ?? null
  );
}

/** The first of `candidates` that exists, so a state without its first choice still lands. */
export function firstOf(
  ...candidates: readonly (Element | null | undefined)[]
): Element | null {
  return candidates.find((one) => one !== null && one !== undefined) ?? null;
}

/** The Copy key of a packet drawn in `inside`, by the sentence it carries. */
export function copyKeyIn(
  inside: Element | null,
  what: string,
): Element | null {
  const keys = inside?.querySelectorAll("button[aria-label]") ?? [];
  return (
    [...keys].find(
      (key) => key.getAttribute("aria-label") === `Copy ${what}`,
    ) ?? null
  );
}

/** Land on `at()` once, when the state this hook lives in first draws, if the keyboard was lost with the last one. */
export function useLandOnMount(at: LandAt): void {
  const target = useRef(at);
  target.current = at;
  useEffect(() => {
    if (stranded()) landFocus(target.current());
  }, []);
}

/** Land on `at()` when `phase` changes and the keyboard was lost with the old state. */
export function useLandOnChange(phase: string, at: LandAt): void {
  const seen = useRef(phase);
  const target = useRef(at);
  target.current = at;
  useEffect(() => {
    if (seen.current === phase) return;
    seen.current = phase;
    if (stranded()) landFocus(target.current());
  }, [phase]);
}

/**
 * Land on `at()` when a busy step settles and the keyboard was lost while its
 * key was disabled: the key that tries again.
 */
export function useLandWhenSettled(busy: boolean, at: LandAt): void {
  const was = useRef(busy);
  const target = useRef(at);
  target.current = at;
  useEffect(() => {
    const settled = was.current && !busy;
    was.current = busy;
    if (settled && stranded()) landFocus(target.current());
  }, [busy]);
}

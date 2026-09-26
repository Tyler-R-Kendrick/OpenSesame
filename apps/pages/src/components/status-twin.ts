/**
 * The touch twin of a status mark's `title` (DESIGN.md § Touch: "every
 * hover-only affordance has a touch twin"; § Status is a symbol).
 *
 * A mark's sentence is its `aria-label` and `title`. A screen reader reads the
 * first and a mouse hovers for the second, but a finger has no hover, so on a
 * phone a refusal carried by a mark could not be read at all. A long press on
 * the mark (the same `longPress` the context menu's hold uses) or a plain tap
 * shows that same sentence in a small transient bubble, and the bubble goes
 * away on its own, on a tap elsewhere, on Escape, or when the page scrolls.
 *
 * A mark inside something that already answers a tap — a link, a button, a
 * row of a listing — has no twin: the parent keeps its own activation, and
 * the mark neither swallows the tap nor widens the parent's hit area.
 */
import { type RefObject, useEffect, useState } from "react";
import { longPress } from "../lib/gestures.js";

/** How long the bubble stays after it is shown or the finger lifts. */
export const STATUS_BUBBLE_MS = 3200;

/** What already owns a tap, so a mark inside it stays a plain glyph. */
const INTERACTIVE = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=tree]",
  "[role=treeitem]",
  "[role=menuitem]",
  "[role=option]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=radio]",
].join(",");

export function insideInteractive(el: Element): boolean {
  return el.parentElement?.closest(INTERACTIVE) != null;
}

function isTouch(event: PointerEvent): boolean {
  return event.pointerType === "touch" || event.pointerType === "pen";
}

/**
 * Wires the tap and the hold on `ref`'s mark. `tappable` is false until the
 * mark is known to stand outside every interactive parent; the component
 * marks itself (`data-touch-twin`) only then, which is what grows its hit
 * area and what the phone audit measures as a target.
 */
/** Whether the bubble is up, and whether this mark answers a tap at all. */
export type StatusTwin = { open: boolean; tappable: boolean };

export function useStatusTwin(ref: RefObject<HTMLElement | null>): StatusTwin {
  const [open, setOpen] = useState(false);
  const [tappable, setTappable] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || insideInteractive(el)) return;
    setTappable(true);
    let timer: number | undefined;
    let shown = false;
    let touch = false;
    const hide = () => {
      shown = false;
      setOpen(false);
    };
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(hide, STATUS_BUBBLE_MS);
    };
    const show = () => {
      shown = true;
      setOpen(true);
      arm();
    };
    const down = (event: PointerEvent) => {
      touch = isTouch(event);
    };
    // The bubble lingers for its full time after the finger lifts.
    const up = () => {
      if (shown) arm();
    };
    // Android answers a hold with its own contextmenu; the hold already
    // showed the sentence, so that one menu is not also opened.
    const menu = (event: MouseEvent) => {
      if (touch) event.preventDefault();
    };
    const stopHold = longPress(el, show);
    el.addEventListener("click", show);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("contextmenu", menu);
    return () => {
      window.clearTimeout(timer);
      stopHold();
      el.removeEventListener("click", show);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("contextmenu", menu);
    };
  }, [ref]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (event: Event) => {
      const at = event.target;
      if (at instanceof Node && ref.current?.contains(at)) return;
      close();
    };
    // Escape is the bubble's while it shows: the Escape ladder and the
    // keymap stand down (statusBubbleOpen), and nothing after this runs, so
    // one press closes one thing.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, ref]);

  return { open, tappable };
}

/** A bubble's top-left corner, in viewport pixels. */
export type BubblePlace = { left: number; top: number };

/** Where the bubble sits: above the mark, or below it near the top edge,
 *  and never past either side of the viewport. */
export function placeBubble(
  mark: Pick<DOMRectReadOnly, "left" | "top" | "width" | "bottom">,
  bubble: { width: number; height: number },
  viewport: { width: number },
): BubblePlace {
  const gap = 6;
  const edge = 8;
  const centred = mark.left + mark.width / 2 - bubble.width / 2;
  const left = Math.min(
    Math.max(centred, edge),
    Math.max(edge, viewport.width - bubble.width - edge),
  );
  const above = mark.top - bubble.height - gap;
  const top = above >= edge ? above : mark.bottom + gap;
  return { left, top };
}

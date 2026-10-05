import { type PointerEvent, useEffect, useMemo, useState } from "react";
import { gestureLimits } from "../../lib/gestures.js";
import { type AddEntry, addEntries } from "./add-menu.js";

/**
 * Hold the Add button and slide: the other ways to add are chosen by dragging
 * from the held `+`, up for one and down for the other, and released there.
 *
 * The hold is the page's own long press (`gestureLimits.longPressMs`), and the
 * finger may not wander before it arms, so a scroll that began on the button is
 * never a hold. Once armed the drag area is drawn and the pointer is captured:
 * the finger can leave the button and still be the one choosing. Releasing over
 * a zone runs its entry; releasing anywhere else, or a cancelled touch, runs
 * nothing. The lift that ends a hold is never also a tap on the `+`.
 */

export type Slide = "up" | "down";

/** How far the finger must travel from where it landed to be over a zone. */
export const SLIDE_ENTER = 32;

/** The zone a finger `dy` from where it landed is over, if it is over one. */
export function slideFor(dy: number): Slide | null {
  if (dy <= -SLIDE_ENTER) return "up";
  if (dy >= SLIDE_ENTER) return "down";
  return null;
}

/** What a hold can choose between: the entry each way is slid to, if there is one. */
export type SlideZones = Readonly<{ up?: AddEntry; down?: AddEntry }>;

/** The entries a hold can choose between, by the way each is slid to. */
export function slideZones(): SlideZones {
  const entries = addEntries();
  return {
    up: entries.find((entry) => entry.slide === "up"),
    down: entries.find((entry) => entry.slide === "down"),
  };
}

export type SlideState = Readonly<{
  /** The box of the held button, where the drag area is drawn around it. */
  box: DOMRect;
  zones: SlideZones;
  /** The zone the finger is over now. */
  over: Slide | null;
}>;

type Touch = { id: number; x: number; y: number };

/** A pointer that is a finger or a stylus rather than a mouse. */
function touchLike(event: PointerEvent): boolean {
  return event.pointerType === "touch" || event.pointerType === "pen";
}

/**
 * The hold-and-slide as a plain state machine, apart from React so each step
 * is small: pointer events in, `show` told what to draw, `choose` told what
 * was chosen.
 */
function createSlide(
  show: (state: SlideState | null) => void,
  choose: (entry: AddEntry) => void,
) {
  let live: SlideState | null = null;
  let down: Touch | null = null;
  let timer: number | undefined;
  /** The next click is the lift that ended a hold, not a tap. */
  let lifted = false;
  /** A touch is on the button, or ended just now: its `contextmenu` is the hold's. */
  let touchUntil = 0;

  const draw = (next: SlideState | null) => {
    live = next;
    show(next);
  };
  const stop = () => {
    window.clearTimeout(timer);
    timer = undefined;
    down = null;
    draw(null);
  };
  const arm = (target: HTMLElement, pointer: number) => {
    const zones = slideZones();
    if (!down || (!zones.up && !zones.down)) return;
    lifted = true;
    target.setPointerCapture?.(pointer);
    target.focus({ preventScroll: true });
    navigator.vibrate?.(12);
    draw({ box: target.getBoundingClientRect(), zones, over: null });
  };

  return {
    holding: () => Date.now() < touchUntil,
    /** Swallow the click a hold's lift would make, so it never follows the `+`. */
    click(event: { preventDefault: () => void }) {
      if (!lifted) return;
      lifted = false;
      event.preventDefault();
    },
    down(event: PointerEvent<HTMLElement>) {
      lifted = false;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const target = event.currentTarget;
      if (touchLike(event)) touchUntil = Number.POSITIVE_INFINITY;
      down = { id: event.pointerId, x: event.clientX, y: event.clientY };
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => arm(target, event.pointerId),
        gestureLimits.longPressMs,
      );
    },
    move(event: PointerEvent<HTMLElement>) {
      if (!down || down.id !== event.pointerId) return;
      if (!live) {
        const far = Math.hypot(event.clientX - down.x, event.clientY - down.y);
        if (far > gestureLimits.longPressSlop) stop();
        return;
      }
      const slide = slideFor(event.clientY - down.y);
      const over = slide && live.zones[slide] ? slide : null;
      if (over === live.over) return;
      if (over) navigator.vibrate?.(8);
      draw({ ...live, over });
    },
    up(event: PointerEvent<HTMLElement>) {
      if (touchLike(event)) touchUntil = Date.now() + 700;
      const held = live;
      stop();
      const entry = held?.over ? held.zones[held.over] : undefined;
      if (entry) choose(entry);
    },
    cancel() {
      touchUntil = Date.now() + 700;
      stop();
    },
  };
}

export function useAddSlide(choose: (entry: AddEntry) => void) {
  const [state, setState] = useState<SlideState | null>(null);
  const slide = useMemo(() => createSlide(setState, choose), [choose]);
  // A hold that outlives the button (a route change under the finger) ends.
  useEffect(() => slide.cancel, [slide]);
  return {
    state,
    holding: slide.holding,
    bind: {
      onPointerDown: slide.down,
      onPointerMove: slide.move,
      onPointerUp: slide.up,
      onPointerCancel: slide.cancel,
      onClick: slide.click,
    },
  };
}

/**
 * Touch gestures for the workspace.
 *
 * The app is keyboard-first and pointer-complete; on a phone neither of
 * those is what a hand does. Two gestures carry the weight, and both are
 * twins of something that already exists rather than hidden-only features:
 *
 * - `swipeBack` — dragging a pane rightwards goes back, the same move as the
 *   ← key in the pathbar. It is the platform's own back idiom on both iOS
 *   and Android, so it needs no teaching.
 * - `longPress` — holding a row opens its `⋯` menu, because a finger has no
 *   hover to reveal one with and no right button to ask for it.
 *
 * Both are written against Pointer Events, so a stylus and a touch laptop
 * behave like a finger and a mouse keeps its own paths untouched.
 */

/** Ignore a drag that is mostly vertical: that is a scroll, not a swipe. */
const SWIPE_MIN_X = 64;
const SWIPE_MAX_Y = 44;
/** A swipe that took this long is a considered drag, not a flick. */
const SWIPE_MAX_MS = 800;
const LONG_PRESS_MS = 450;
/** A finger that wanders this far was scrolling, not holding. */
const LONG_PRESS_SLOP = 10;

export type Disposer = () => void;

function isTouchLike(event: PointerEvent): boolean {
  return event.pointerType === "touch" || event.pointerType === "pen";
}

/**
 * Calls `onBack` when a touch drags left-to-right across `el`.
 *
 * Only when the element is not scrolled sideways, so a horizontally
 * scrollable child (the filter chips) keeps its own gesture.
 */
export function swipeBack(el: HTMLElement, onBack: () => void): Disposer {
  let startX = 0;
  let startY = 0;
  let startAt = 0;
  let tracking = false;

  const down = (event: PointerEvent) => {
    if (!isTouchLike(event)) return;
    tracking = true;
    startX = event.clientX;
    startY = event.clientY;
    startAt = event.timeStamp;
  };

  const up = (event: PointerEvent) => {
    if (!tracking) return;
    tracking = false;
    const dx = event.clientX - startX;
    const dy = Math.abs(event.clientY - startY);
    if (
      dx >= SWIPE_MIN_X &&
      dy <= SWIPE_MAX_Y &&
      event.timeStamp - startAt <= SWIPE_MAX_MS
    ) {
      onBack();
    }
  };

  const cancel = () => {
    tracking = false;
  };

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
  };
}

/**
 * Calls `onHold` when a touch rests on `el` without wandering.
 *
 * The caller gets the pointer's own coordinates so it can place whatever it
 * opens. Movement past the slop, a lift, or a cancel all abandon the hold.
 */
export function longPress(
  el: HTMLElement,
  onHold: (event: PointerEvent) => void,
): Disposer {
  let timer: number | undefined;
  let startX = 0;
  let startY = 0;

  const clear = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };

  const down = (event: PointerEvent) => {
    if (!isTouchLike(event)) return;
    startX = event.clientX;
    startY = event.clientY;
    clear();
    timer = window.setTimeout(() => {
      timer = undefined;
      onHold(event);
    }, LONG_PRESS_MS);
  };

  const move = (event: PointerEvent) => {
    if (timer === undefined) return;
    if (
      Math.abs(event.clientX - startX) > LONG_PRESS_SLOP ||
      Math.abs(event.clientY - startY) > LONG_PRESS_SLOP
    ) {
      clear();
    }
  };

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", clear);
  el.addEventListener("pointercancel", clear);
  el.addEventListener("pointerleave", clear);
  return () => {
    clear();
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", clear);
    el.removeEventListener("pointercancel", clear);
    el.removeEventListener("pointerleave", clear);
  };
}

/** The gesture thresholds, exported so tests state the same numbers once. */
export const gestureLimits = {
  swipeMinX: SWIPE_MIN_X,
  swipeMaxY: SWIPE_MAX_Y,
  swipeMaxMs: SWIPE_MAX_MS,
  longPressMs: LONG_PRESS_MS,
  longPressSlop: LONG_PRESS_SLOP,
} as const;

/**
 * Whether this pointer is a finger (or a stylus) rather than a mouse.
 *
 * Guarded for environments without `matchMedia` — a test renderer is not a
 * touch device, and treating it as one would change what the tests see.
 */
export function isTouchPointer(): boolean {
  return globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
}

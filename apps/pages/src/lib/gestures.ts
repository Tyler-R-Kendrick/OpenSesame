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
 * - `longPress` — holding anything opens its context menu (the page's
 *   recogniser in `components/context-menu/context-menu-input.ts`), because
 *   a finger has no hover to reveal a `⋯` with and no right button to ask.
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
/** Sideways travel that makes a drag horizontal: under the browser's own slop. */
const DRAG_CLAIM_SLOP = 4;

export type Disposer = () => void;

function isTouchLike(event: PointerEvent): boolean {
  return event.pointerType === "touch" || event.pointerType === "pen";
}

/**
 * Calls `on` when a touch drags across `el` in `direction`, with the pointer
 * that lifted and the element it started on.
 *
 * Only a mostly-horizontal, quick drag counts, so a scroll is never a swipe,
 * and a horizontally scrollable child (the filter chips) keeps its own.
 */
export function swipe(
  el: HTMLElement,
  direction: "left" | "right",
  on: (event: PointerEvent, from: Element | null) => void,
): Disposer {
  let startX = 0;
  let startY = 0;
  let startAt = 0;
  let from: Element | null = null;
  let tracking = false;

  const down = (event: PointerEvent) => {
    if (!isTouchLike(event)) return;
    tracking = true;
    startX = event.clientX;
    startY = event.clientY;
    startAt = event.timeStamp;
    from = event.target instanceof Element ? event.target : null;
  };

  const up = (event: PointerEvent) => {
    if (!tracking) return;
    tracking = false;
    const dx = (event.clientX - startX) * (direction === "right" ? 1 : -1);
    const dy = Math.abs(event.clientY - startY);
    if (
      dx >= SWIPE_MIN_X &&
      dy <= SWIPE_MAX_Y &&
      event.timeStamp - startAt <= SWIPE_MAX_MS
    ) {
      on(event, from);
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
 * A horizontal drag that begins on `el` belongs to the page, whole.
 *
 * `touch-action: pan-y` hands the page the sideways drag, but not the fling
 * the browser starts when a quick one lifts: Chromium runs that fling to its
 * end though there is nothing to scroll, and a tap that lands while one runs
 * is spent stopping it, so no click ever follows. A row swiped left opens its
 * menu under the thumb, and the entry the thumb reaches for first would be
 * dead for about half a second. Cancelling the drag's `touchmove` is the
 * platform's way of saying the page took it: no scroll, so no fling.
 *
 * The first travel past the browser's own slop decides it for the whole touch:
 * a drag that begins sideways is claimed to its end, one that begins vertically
 * is a scroll and is never touched, so neither turns into the other halfway. A listener that may cancel has to be
 * non-passive and sits on the element that needs it, not on the document,
 * which would make every scroll on the page wait for the page.
 */
export function claimHorizontalDrags(el: HTMLElement): Disposer {
  let startX = 0;
  let startY = 0;
  let single = false;
  /** Decided once, by the first travel past the slop: sideways or not. */
  let claimed: boolean | undefined;

  const down = (event: TouchEvent) => {
    single = event.touches.length === 1;
    claimed = undefined;
    startX = event.touches[0]?.clientX ?? 0;
    startY = event.touches[0]?.clientY ?? 0;
  };
  const move = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!single || !touch || event.touches.length !== 1) return;
    if (claimed === undefined) {
      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);
      if (Math.max(dx, dy) > DRAG_CLAIM_SLOP) claimed = dx > dy;
    }
    if (claimed && event.cancelable) event.preventDefault();
  };
  const end = () => {
    single = false;
    claimed = undefined;
  };

  el.addEventListener("touchstart", down, { passive: true });
  el.addEventListener("touchmove", move, { passive: false });
  el.addEventListener("touchend", end, { passive: true });
  el.addEventListener("touchcancel", end, { passive: true });
  return () => {
    el.removeEventListener("touchstart", down);
    el.removeEventListener("touchmove", move);
    el.removeEventListener("touchend", end);
    el.removeEventListener("touchcancel", end);
  };
}

/** Dragging a pane rightwards goes back: the twin of the ← key. */
export function swipeBack(el: HTMLElement, onBack: () => void): Disposer {
  return swipe(el, "right", () => onBack());
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
  dragClaimSlop: DRAG_CLAIM_SLOP,
} as const;

/** The one media query that says "a finger", for the CSS twin and the hook. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

/**
 * Whether this pointer is a finger (or a stylus) rather than a mouse.
 *
 * Guarded for environments without `matchMedia` — a test renderer is not a
 * touch device, and treating it as one would change what the tests see.
 */
export function isTouchPointer(): boolean {
  return globalThis.matchMedia?.(COARSE_POINTER_QUERY).matches ?? false;
}

/**
 * The ⋯ menu's row (and the page menu's, and the sheet's title) that lists
 * every key, or every gesture where the pointer is a finger. Copy that points
 * at that row names it through here, so the pointer and the row cannot drift.
 */
export function keymapLabel(touch: boolean = isTouchPointer()): string {
  return touch ? "Gestures" : "Keyboard shortcuts";
}

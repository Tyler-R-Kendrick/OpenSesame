/**
 * Swipe a page sideways to move along its tabs.
 *
 * One finger is the page's (`lib/gestures.ts`), and a screen with a tab strip
 * is a book of pages: a quick drag left turns to the next tab, a drag right to
 * the one before, the way the platform's own pagers do. It is the twin of
 * tapping the neighbouring tab, so it clicks that tab and nothing else: the
 * tab's own handler (a route link, a button) decides what selecting it means,
 * and it never moves focus. Nothing wraps; the first tab has no tab before it.
 *
 * Which strip is the one nearest above the finger, so a page with tabs inside
 * a tab turns the inner pages when the finger is on them, and passes the swipe
 * out to the tabs around them once the inner ones run out. The swipe stands down
 * wherever the drag already belongs to something else: a listing (a row swiped
 * left asks for its actions), a text field, a slider, anything that scrolls
 * sideways (the strip itself, once it outgrows the phone), an open menu, and a
 * modal that does not hold the finger.
 */
import { textEntryFocused } from "./gesture-runtime.js";
import { gestureLimits } from "./gestures.js";
import { contextMenuOpen, listingOf, typing } from "./keymap-targets.js";

/** A tab strip: the ARIA tablist, and the nav of links Settings and Wallet draw. */
const STRIPS = '[role="tablist"], .set__nav';
const TABS = '[role="tab"], .set__nav-link';
const CURRENT = '[aria-selected="true"], [aria-current="page"]';
const MODAL = '[role="dialog"][aria-modal="true"]';
/** What a drag on it means is its own, whatever page it is on. */
const OWN_DRAG = '[role="slider"], [role="textbox"]';

function rendered(element: HTMLElement): boolean {
  return (
    element.closest('[hidden], [inert], [aria-hidden="true"]') === null &&
    (element.checkVisibility?.() ?? true)
  );
}

function enabled(element: HTMLElement): boolean {
  return (
    !element.hasAttribute("disabled") &&
    element.getAttribute("aria-disabled") !== "true"
  );
}

/** Whether a drag from `from` up to `root` would scroll something sideways. */
function scrollsSideways(from: Element, root: Element): boolean {
  let node: Element | null = from;
  while (node && node !== document.body) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const { overflowX } = getComputedStyle(node);
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
    node = node === root ? null : node.parentElement;
  }
  return false;
}

/** The strips above (or holding) `from` inside `scope`, nearest first. */
function stripsAbove(from: Element, scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(STRIPS)]
    .filter(
      (strip) =>
        strip.compareDocumentPosition(from) &
          Node.DOCUMENT_POSITION_FOLLOWING && rendered(strip),
    )
    .reverse();
}

/** Whether the drag from `target` is already something else's, whatever the page. */
function claimedElsewhere(target: Element): boolean {
  return (
    contextMenuOpen() ||
    typing(target) ||
    textEntryFocused() ||
    listingOf({ target }) !== null ||
    target.closest(OWN_DRAG) !== null
  );
}

/**
 * Where the touch looks for its strip: the modal that holds it, else the page's
 * main. Null when a modal that does not hold the finger is up.
 */
function scopeOf(target: Element): Element | null {
  const modal = target.closest(MODAL);
  if (modal) return modal;
  if (document.querySelector(MODAL) !== null) return null;
  return target.closest("main") ?? document.body;
}

/** The tab `step` places from the selected one on `strip`, if there is one. */
function neighbour(strip: HTMLElement, step: 1 | -1): HTMLElement | undefined {
  const tabs = [...strip.querySelectorAll<HTMLElement>(TABS)].filter(
    (tab) => enabled(tab) && rendered(tab),
  );
  const at = tabs.findIndex((tab) => tab.matches(CURRENT));
  return at < 0 ? undefined : tabs[at + step];
}

/**
 * Select the tab `step` places from the selected one on the page under a touch
 * that began at `target`: 1 is the next, -1 the one before. False when this
 * touch is not a tab turn: no strip, no such tab, or the drag is not the page's.
 */
export function swipeTabs(target: EventTarget | null, step: 1 | -1): boolean {
  if (!(target instanceof Element) || claimedElsewhere(target)) return false;
  const scope = scopeOf(target);
  if (!scope || scrollsSideways(target, scope)) return false;
  // A strip at its last tab in that direction hands the swipe to the one above
  // it, the way a pager inside a pager does.
  let next: HTMLElement | undefined;
  for (const strip of stripsAbove(target, scope)) {
    next = neighbour(strip, step);
    if (next) break;
  }
  if (!next) return false;
  navigator.vibrate?.(8);
  next.click();
  return true;
}

type Touching = Readonly<{
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}>;

/** A list's fingers, tolerant of a synthetic event that lists none. */
function fingersOf(list: TouchList | undefined): Touching[] {
  return list ? Array.from(list) : [];
}

type Start = Readonly<{
  x: number;
  y: number;
  at: number;
  target: EventTarget | null;
}>;

/**
 * The touch handlers, apart from where they are attached so a test can drive
 * them. A second finger spoils the touch: two fingers are the keymap's
 * (ADR 0170) and a pinch is the browser's.
 */
export function createTabSwipe(now: () => number = () => performance.now()) {
  let start: Start | null = null;

  const down = (event: TouchEvent) => {
    const [finger] = fingersOf(event.changedTouches);
    if (!finger || fingersOf(event.touches).length > 1) {
      start = null;
      return;
    }
    start = {
      x: finger.clientX,
      y: finger.clientY,
      at: now(),
      target: finger.target,
    };
  };

  const up = (event: TouchEvent) => {
    if (fingersOf(event.touches).length > 0) {
      start = null;
      return;
    }
    const from = start;
    start = null;
    const [finger] = fingersOf(event.changedTouches);
    if (!from || !finger) return;
    const dx = finger.clientX - from.x;
    const dy = Math.abs(finger.clientY - from.y);
    const { swipeMinX, swipeMaxY, swipeMaxMs } = gestureLimits;
    // A flick that is mostly sideways; a scroll that drifted is not one.
    if (Math.abs(dx) < swipeMinX || dy > swipeMaxY || Math.abs(dx) < dy * 2)
      return;
    if (now() - from.at > swipeMaxMs) return;
    swipeTabs(from.target, dx < 0 ? 1 : -1);
  };

  const cancel = () => {
    start = null;
  };

  return { down, up, cancel };
}

/** Listen on the document. Every listener is passive: a flick is never held up. */
export function installTabSwipe(root: Document = document): () => void {
  const handlers = createTabSwipe();
  const options = { capture: true, passive: true } as const;
  root.addEventListener("touchstart", handlers.down, options);
  root.addEventListener("touchend", handlers.up, options);
  root.addEventListener("touchcancel", handlers.cancel, options);
  return () => {
    root.removeEventListener("touchstart", handlers.down, true);
    root.removeEventListener("touchend", handlers.up, true);
    root.removeEventListener("touchcancel", handlers.cancel, true);
  };
}

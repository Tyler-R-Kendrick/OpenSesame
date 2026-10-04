/**
 * The shell's half of the gesture loadout (ADR 0164): touch events in, the
 * keymap's own commands out. The recognizer in app-core decides what two
 * fingers did; this listens, stands down where a gesture would be wrong, and
 * runs what the gesture is bound to through `runTarget`, the one place a
 * command id becomes an action, so a gesture can only do what a key could.
 *
 * One finger is never read here (it is the page's, `lib/gestures.ts`), and
 * a swipe is the page's too unless it began in a listing and is bound: only
 * then is its drag claimed, so an unbound two-finger scroll still scrolls.
 */
import { effectiveGestures } from "@opensesame/app-core/lib/keymap/gesture-bindings.js";
import {
  type TouchSession,
  beginSession,
  fingerDown,
  fingerMove,
  finish,
  swipeInProgress,
} from "@opensesame/app-core/lib/keymap/gesture-recognizer.js";
import {
  GESTURES,
  type GestureId,
} from "@opensesame/app-core/lib/keymap/gestures.js";
import { loadKeymap } from "@opensesame/app-core/lib/keymap/store.js";
import type { ChordState } from "./keymap-chord.js";
import { runTarget } from "./keymap-commands.js";
import { recordRun } from "./keymap-registers.js";
import {
  type Origin,
  contextMenuOpen,
  listingOf,
  typing,
} from "./keymap-targets.js";

export type GestureHost = Readonly<{
  navigate: (path: string) => void;
  showHelp: () => void;
  /** The shell's chord: a recording in progress takes a gesture's command too. */
  chord?: ChordState;
  /** The clock, so a test can say how long a touch took. */
  now?: () => number;
}>;

/** A gesture is the page's, not the keymap's, wherever something else holds the screen. */
export function gestureStandsDown(target: EventTarget | null): boolean {
  return (
    contextMenuOpen() ||
    typing(target) ||
    document.querySelector('[role="dialog"][aria-modal="true"]') !== null
  );
}

/** Whether `id` is a swipe: one that must begin in a listing. */
function isSwipe(id: GestureId): boolean {
  return GESTURES.some(
    (gesture) => gesture.id === id && gesture.family === "swipe",
  );
}

/**
 * Run what `id` is bound to, as the keymap would run a key: from `origin`,
 * once, and into a register recording if one is on. Nothing when it is
 * unbound, struck, or something else holds the screen.
 */
export function runGesture(
  id: GestureId,
  origin: Origin,
  host: GestureHost,
): boolean {
  const target = effectiveGestures(loadKeymap()).get(id);
  if (target === undefined || gestureStandsDown(origin.target)) return false;
  navigator.vibrate?.(8);
  runTarget(target, {
    event: origin,
    steps: 1,
    hadCount: false,
    navigate: host.navigate,
    showHelp: host.showHelp,
  });
  if (host.chord) recordRun(host.chord.registers, target, 1);
  return true;
}

type Touching = Readonly<{
  identifier: number;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}>;

function changed(event: TouchEvent): Touching[] {
  return Array.from(event.changedTouches);
}

/** One touch as the handlers follow it, from first finger down to last up. */
type Tracking = {
  session: TouchSession;
  origin: Origin;
  /** Every finger landed in the same listing: a swipe may count. */
  inListing: boolean;
};

/**
 * The touch handlers, apart from where they are attached so a test can drive
 * them. `start`, `move` and `end` take the touch events themselves.
 */
export function createGestureHandlers(host: GestureHost) {
  const now = host.now ?? (() => performance.now());
  let tracking: Tracking | null = null;
  /** A touch that began where a gesture must stand down is ignored to its end. */
  let ignoring = false;

  const fresh = (event: TouchEvent) =>
    event.touches.length <= event.changedTouches.length;

  const start = (event: TouchEvent) => {
    if (fresh(event)) {
      tracking = null;
      ignoring = false;
    }
    if (ignoring) return;
    const [first] = changed(event);
    if (first && !tracking && gestureStandsDown(first.target)) {
      ignoring = true;
      return;
    }
    for (const finger of changed(event)) {
      const listing = listingOf({ target: finger.target });
      if (!tracking) {
        tracking = {
          session: beginSession(now()),
          origin: { target: finger.target },
          inListing: listing !== null,
        };
      } else if (listing !== listingOf(tracking.origin)) {
        tracking.inListing = false;
      }
      fingerDown(
        tracking.session,
        finger.identifier,
        { x: finger.clientX, y: finger.clientY },
        now(),
      );
    }
  };

  const follow = (event: TouchEvent) => {
    if (!tracking) return;
    for (const finger of changed(event)) {
      fingerMove(tracking.session, finger.identifier, {
        x: finger.clientX,
        y: finger.clientY,
      });
    }
  };

  /** Once a bound swipe is sure, the drag is the page's: no scroll under it. */
  const move = (event: TouchEvent) => {
    follow(event);
    if (!tracking?.inListing || !event.cancelable) return;
    const swipe = swipeInProgress(tracking.session);
    if (swipe && effectiveGestures(loadKeymap()).has(swipe))
      event.preventDefault();
  };

  const end = (event: TouchEvent) => {
    follow(event);
    if (event.touches.length > 0 || !tracking) {
      if (event.touches.length === 0) ignoring = false;
      return;
    }
    const done = tracking;
    tracking = null;
    ignoring = false;
    const gesture = finish(done.session, now());
    if (gesture === null || (isSwipe(gesture) && !done.inListing)) return;
    runGesture(gesture, done.origin, host);
  };

  const cancel = () => {
    tracking = null;
    ignoring = false;
  };

  return { start, move, end, cancel };
}

/**
 * Listen for gestures on the document. The move listener is not passive,
 * because it may cancel a drag it has claimed; it does nothing at all until
 * two fingers are down in a listing, so a scroll never waits on it.
 */
export function installGestures(
  host: GestureHost,
  root: Document = document,
): () => void {
  const handlers = createGestureHandlers(host);
  root.addEventListener("touchstart", handlers.start, {
    capture: true,
    passive: true,
  });
  root.addEventListener("touchmove", handlers.move, {
    capture: true,
    passive: false,
  });
  root.addEventListener("touchend", handlers.end, {
    capture: true,
    passive: true,
  });
  root.addEventListener("touchcancel", handlers.cancel, {
    capture: true,
    passive: true,
  });
  return () => {
    root.removeEventListener("touchstart", handlers.start, true);
    root.removeEventListener("touchmove", handlers.move, true);
    root.removeEventListener("touchend", handlers.end, true);
    root.removeEventListener("touchcancel", handlers.cancel, true);
  };
}

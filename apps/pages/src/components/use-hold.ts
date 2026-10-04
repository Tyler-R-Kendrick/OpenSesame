import { useCallback, useRef } from "react";
import { longPress } from "../lib/gestures.js";

/**
 * `bind` is a callback ref, so it composes with the ones a control already
 * carries. `consumeHold()` is for the click that follows the lift of a hold:
 * that click must not undo what the hold did, so whatever receives it asks
 * first and ignores it when it is true. That is not always the control: what
 * the hold opened can have appeared under the finger, and the browser then
 * aims the lift's click at it (a backdrop that closes on click, say).
 */
export type Hold = {
  bind: (element: HTMLElement | null) => void;
  consumeHold: () => boolean;
};

/**
 * A finger held on a control, as the other half of pressing it: `onHold` runs
 * once the finger has rested without wandering (`longPress`, which only
 * listens to touch and pen). `applies` is asked of the element at the moment
 * of the hold: a control that is only sometimes held for something answers
 * for the form it is drawn in now, and a hold that does not apply is not one.
 */
export function useHold(
  onHold: () => void,
  applies: (element: HTMLElement) => boolean = () => true,
): Hold {
  const latest = useRef(onHold);
  latest.current = onHold;
  const appliesNow = useRef(applies);
  appliesNow.current = applies;
  const held = useRef(false);
  const stop = useRef<(() => void) | null>(null);

  const bind = useCallback((element: HTMLElement | null) => {
    stop.current?.();
    stop.current = null;
    if (!element) return;
    const release = longPress(element, () => {
      if (!appliesNow.current(element)) return;
      held.current = true;
      navigator.vibrate?.(8);
      latest.current();
    });
    // Any press anywhere begins a new sequence: a hold whose lift never
    // produced a click (Android sends a `contextmenu` instead) must not
    // swallow the next tap, wherever it lands.
    const down = () => {
      held.current = false;
    };
    // …and so does a key: Enter or Space on the control, after the menu a hold
    // opened was closed from the keyboard, is a press, not the hold's lift.
    const doc = element.ownerDocument;
    doc.addEventListener("pointerdown", down, true);
    doc.addEventListener("keydown", down, true);
    stop.current = () => {
      release();
      doc.removeEventListener("pointerdown", down, true);
      doc.removeEventListener("keydown", down, true);
    };
  }, []);

  const consumeHold = useCallback(() => {
    const was = held.current;
    held.current = false;
    return was;
  }, []);

  return { bind, consumeHold };
}

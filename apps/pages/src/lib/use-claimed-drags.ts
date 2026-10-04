import { type RefObject, useEffect } from "react";
import { claimHorizontalDrags } from "./gestures.js";

/**
 * A listing whose rows are swiped sideways for their menu keeps the browser
 * out of the drag (`claimHorizontalDrags`): the swipe is the page's, and no
 * fling is left running to swallow the tap on the menu's first entry.
 */
export function useClaimedDrags(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    return el ? claimHorizontalDrags(el) : undefined;
  }, [ref]);
}

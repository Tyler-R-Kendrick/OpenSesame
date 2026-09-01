/**
 * React bindings for the semantic target registry.
 *
 * Instrumenting a control is one hook call and one ref. Registration follows
 * the component's own lifecycle, so a target exists exactly while the control
 * it names is on screen — which is what lets a guide wait for `appear` and
 * `disappear` without anybody polling the DOM.
 */

import type { GuideTargetId } from "@opensesame/guide-lang";
import { type ReactNode, useCallback, useRef } from "react";
import { mountGuideTarget } from "./targets.js";

/**
 * Returns a ref to spread onto the element that *is* the named control — the
 * button, the link, the panel. Attach it to the smallest element a person
 * would point at, because that is what gets highlighted.
 *
 * A callback ref rather than an object one, because binding has to follow the
 * element and not the component. An effect keyed on the id reads `ref.current`
 * once and never again, so a control rendered later — the health link inside
 * the notifications sheet, a Settings row on a category the person has not
 * opened yet — would never register at all, and a control that swapped between
 * two branches would leave the registry holding the node React had already
 * removed. React calls this on attach and again with the detach, so the
 * registry tracks what is actually on screen.
 */
export function useGuideTarget<E extends HTMLElement = HTMLElement>(
  id: GuideTargetId,
): (element: E | null) => void {
  const bound = useRef<(() => void) | null>(null);
  return useCallback(
    (element: E | null) => {
      bound.current?.();
      bound.current = element ? mountGuideTarget(id, element) : null;
    },
    [id],
  );
}

/**
 * Wrapper for controls whose element is rendered by something that does not
 * forward a ref. Renders a plain `<span>` that carries no layout of its own.
 */
export function GuideTarget({
  id,
  children,
}: {
  id: GuideTargetId;
  children?: ReactNode;
}) {
  const ref = useGuideTarget<HTMLSpanElement>(id);
  return (
    <span ref={ref} className="guide-target" data-guide-target={id}>
      {children}
    </span>
  );
}

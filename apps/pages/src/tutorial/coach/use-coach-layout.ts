import { resolveGuideTargetElement } from "@opensesame/app-core/tutorial/registry/targets.js";
import type { GuideTourView } from "@opensesame/guide-runtime";
import { type RefObject, useCallback } from "react";
import { padded } from "./CoachParts.js";
import { clearOfDock, placeCoach } from "./placement.js";
import { useGlide } from "./use-coach-behavior.js";
import {
  useLiveRect,
  useMeasured,
  usePhoneLayout,
  useViewport,
} from "./use-geometry.js";

/**
 * Where everything goes for one step: the aperture around the lit control,
 * the card beside it, and whether the control is there at all. Pure
 * arithmetic over what the page reports each frame.
 */
export function useCoachLayout(
  runId: number,
  tour: GuideTourView,
  card: RefObject<HTMLElement | null>,
) {
  const target = tour.target;
  const rect = useLiveRect(
    useCallback(
      () =>
        target !== null && !tour.degraded
          ? resolveGuideTargetElement(target)
          : null,
      [target, tour.degraded],
    ),
  );
  const viewport = useViewport();
  const phone = usePhoneLayout();
  const stepKey = `${runId}:${tour.kind}:${tour.step}`;
  const size = useMeasured(card, `${stepKey}:${tour.message}:${phone}`);
  const box = rect === null ? null : padded(rect);
  const placement =
    size === null
      ? null
      : placeCoach({
          viewport,
          card: size,
          target: box,
          prefer: tour.side,
          phone,
        });
  const hole =
    box !== null && size !== null && placement?.kind === "dock"
      ? clearOfDock(box, viewport, size, placement.edge)
      : box;
  return {
    stepKey,
    viewport,
    hole,
    placement,
    gliding: useGlide(stepKey),
    // A control that was on screen and is gone — the person navigated away —
    // is the same situation as one that never appeared.
    missing: target !== null && (tour.degraded || rect === null),
  };
}

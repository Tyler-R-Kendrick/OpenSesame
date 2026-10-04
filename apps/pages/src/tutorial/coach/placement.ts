/**
 * Where the coach card sits.
 *
 * Pure geometry, no DOM: the card is placed from the target's rectangle, the
 * card's own measured size and the viewport, so every rule below is a unit
 * test rather than a screenshot. The rules, in order of importance:
 *
 *  1. The card never covers the control the step is about. A step that points
 *     at something and hides it is worse than no step.
 *  2. The card is always fully inside the viewport, whatever the target's
 *     rectangle does at the edges.
 *  3. The author's `side` is a preference, taken when it fits and flipped
 *     when it does not.
 *  4. A step with no control — narration, the closing card — is centred.
 *  5. On a phone the card is a sheet docked to the edge of the screen the
 *     target is *not* on, so the thumb's reach is never the thing it covers.
 */

export type Box = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

export type Size = { readonly width: number; readonly height: number };

export type CoachSide = "top" | "right" | "bottom" | "left";

export type CoachPlacement =
  | {
      readonly kind: "anchored";
      readonly left: number;
      readonly top: number;
      /** Which edge of the card faces the target. */
      readonly facing: CoachSide;
      /** Distance of the notch from the card's leading edge, in px. */
      readonly notch: number;
    }
  | { readonly kind: "floating"; readonly left: number; readonly top: number }
  | { readonly kind: "centered"; readonly left: number; readonly top: number }
  | { readonly kind: "dock"; readonly edge: "top" | "bottom" };

export type PlacementInput = {
  readonly viewport: Size;
  readonly card: Size;
  /** The target's rectangle, already padded by the aperture. Null: no target. */
  readonly target: Box | null;
  readonly prefer: CoachSide | null;
  readonly phone: boolean;
};

/** The device's safe-area insets at the two edges a card docks to, in px. */
export type SafeInsets = { readonly top: number; readonly bottom: number };

export const NO_INSETS: SafeInsets = { top: 0, bottom: 0 };

/** Breathing room between the card and the screen edge. */
export const COACH_MARGIN = 12;
/** Space between the target and the card, where the notch lives. */
export const COACH_GAP = 14;
/** Keep the notch off the card's corners. */
const NOTCH_INSET = 14;

const OPPOSITE = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
} as const satisfies Record<CoachSide, CoachSide>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

function inside(box: Box, viewport: Size): boolean {
  return (
    box.left >= COACH_MARGIN - 0.5 &&
    box.top >= COACH_MARGIN - 0.5 &&
    box.left + box.width <= viewport.width - COACH_MARGIN + 0.5 &&
    box.top + box.height <= viewport.height - COACH_MARGIN + 0.5
  );
}

type Candidate = { readonly box: Box; readonly notch: number };

/** The candidate for one side, centred on the target along the other axis. */
function candidate(
  side: CoachSide,
  target: Box,
  card: Size,
  viewport: Size,
): Candidate {
  const centreX = target.left + target.width / 2;
  const centreY = target.top + target.height / 2;
  let left: number;
  let top: number;
  if (side === "top" || side === "bottom") {
    left = clamp(
      centreX - card.width / 2,
      COACH_MARGIN,
      viewport.width - COACH_MARGIN - card.width,
    );
    top =
      side === "bottom"
        ? target.top + target.height + COACH_GAP
        : target.top - COACH_GAP - card.height;
  } else {
    top = clamp(
      centreY - card.height / 2,
      COACH_MARGIN,
      viewport.height - COACH_MARGIN - card.height,
    );
    left =
      side === "right"
        ? target.left + target.width + COACH_GAP
        : target.left - COACH_GAP - card.width;
  }
  const along = side === "top" || side === "bottom";
  const raw = along ? centreX - left : centreY - top;
  const extent = along ? card.width : card.height;
  return {
    box: { left, top, width: card.width, height: card.height },
    notch: clamp(raw, NOTCH_INSET, extent - NOTCH_INSET),
  };
}

function sidesInOrder(prefer: CoachSide | null): CoachSide[] {
  const order: CoachSide[] = [];
  const push = (side: CoachSide): void => {
    if (!order.includes(side)) order.push(side);
  };
  if (prefer !== null) {
    push(prefer);
    push(OPPOSITE[prefer]);
  }
  for (const side of ["bottom", "top", "right", "left"] as const) push(side);
  return order;
}

/**
 * The part of a lit region the docked card leaves visible. A target as tall as
 * the screen (a whole pane on a phone) cannot be kept clear of a sheet docked
 * to an edge, so the lit area is cut back to what the sheet does not cover:
 * the card never sits on the ring, and what is lit is what can be seen.
 */
export function clearOfDock(
  hole: Box,
  viewport: Size,
  card: Size,
  edge: "top" | "bottom",
  insets: SafeInsets = NO_INSETS,
): Box {
  // The card sits `0.5rem + inset` off its edge (coach.css), so the screen's
  // own inset at that edge is part of what it covers.
  const dock = card.height + COACH_MARGIN * 2 + insets[edge];
  const top = edge === "top" ? Math.max(hole.top, dock) : hole.top;
  const bottom =
    edge === "top"
      ? hole.top + hole.height
      : Math.min(hole.top + hole.height, viewport.height - dock);
  if (bottom - top < 1) return hole;
  return { left: hole.left, top, width: hole.width, height: bottom - top };
}

export function placeCoach(input: PlacementInput): CoachPlacement {
  const { viewport, card, target, prefer, phone } = input;
  if (phone) {
    if (target === null) return { kind: "dock", edge: "bottom" };
    const centre = target.top + target.height / 2;
    return {
      kind: "dock",
      edge: centre > viewport.height / 2 ? "top" : "bottom",
    };
  }
  if (target === null) {
    return {
      kind: "centered",
      left: Math.round((viewport.width - card.width) / 2),
      top: Math.round((viewport.height - card.height) / 2),
    };
  }

  for (const side of sidesInOrder(prefer)) {
    const { box, notch } = candidate(side, target, card, viewport);
    if (!inside(box, viewport) || overlaps(box, target)) continue;
    return {
      kind: "anchored",
      left: Math.round(box.left),
      top: Math.round(box.top),
      // The card's edge that faces the target is the one opposite the side.
      facing: OPPOSITE[side],
      notch: Math.round(notch),
    };
  }

  // Nothing fits beside it (a target as large as the screen): take the corner
  // of the viewport that clears it best, with no notch.
  const corners: Box[] = [
    {
      left: viewport.width - COACH_MARGIN - card.width,
      top: viewport.height - COACH_MARGIN - card.height,
      width: card.width,
      height: card.height,
    },
    {
      left: COACH_MARGIN,
      top: viewport.height - COACH_MARGIN - card.height,
      width: card.width,
      height: card.height,
    },
    {
      left: viewport.width - COACH_MARGIN - card.width,
      top: COACH_MARGIN,
      width: card.width,
      height: card.height,
    },
    {
      left: COACH_MARGIN,
      top: COACH_MARGIN,
      width: card.width,
      height: card.height,
    },
  ];
  const clear = corners.find((corner) => !overlaps(corner, target));
  const chosen = clear ?? corners[0];
  return {
    kind: "floating",
    left: Math.round(chosen?.left ?? COACH_MARGIN),
    top: Math.round(chosen?.top ?? COACH_MARGIN),
  };
}

import { RING_COUNT } from "./constants.js";
import type { QuietRect } from "./layout-types.js";

export type DialGeometry = {
  cx: number;
  cy: number;
  R0: number;
  dr: number;
  fs: number;
  idx: number;
  order: number;
};

export function computeDialGeometry(input: {
  w: number;
  h: number;
  card: QuietRect;
  notes: QuietRect | null;
  narrow: boolean;
  quiet: QuietRect[];
}): DialGeometry {
  const { w, h, card, notes, narrow, quiet } = input;

  if (!narrow && notes) {
    const dr = Math.min(21, Math.max(16, h * 0.023));
    const R0 = Math.max(96, h * 0.11);
    return {
      cx: notes.x,
      cy: h - 30,
      R0,
      dr,
      fs: Math.min(12.5, dr * 0.6),
      idx: -Math.PI / 2,
      order: -1,
    };
  }
  if (!narrow) {
    const cx = w / 2;
    const cy = h / 2;
    const R0 = Math.hypot(card.w, card.h) / 2 + 20;
    const dr = Math.min(12, (h - 14 - (cy + R0)) / (RING_COUNT - 0.4));
    return {
      cx,
      cy,
      R0,
      dr,
      fs: Math.min(10, dr * 0.85),
      idx: Math.PI / 2,
      order: 1,
    };
  }
  // Corner dial in the empty band below the card (and above collapsed notes).
  // Prototype lock-v5-mobile: cx=-18, cy toward the lower-left under notes.
  const cardBottom = card.y + card.h;
  const notesTop = notes ? notes.y : h;
  const band = Math.max(cardBottom + 48, Math.min(notesTop + 36, h - 48));
  return {
    cx: -18,
    cy: Math.max(band, h - 60),
    R0: 62,
    dr: 16,
    fs: 10,
    idx: 0,
    order: 1,
  };
}

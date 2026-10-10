/**
 * The mark: the door ajar — a slab of ink slid aside and a slit of light where
 * it opened. One geometry, in units of the mark's height divided by 17, so the
 * footprint is a square. Every drawing of it derives from these numbers: the
 * SVG `IconMark`, `public/icon.svg`, and the slab the wordmark paints at plate
 * height. Change them here or nowhere (`mark-geometry.test.ts` pins the icon).
 */
export const MARK_UNITS = 17;
export const MARK_SLAB_U = 12;
export const MARK_GAP_U = 2.7;
export const MARK_SLIT_U = 2.3;

export type MarkRect = { x: number; y: number; w: number; h: number };

/** The two rectangles of one mark. */
export type MarkGeometry = { slab: MarkRect; slit: MarkRect };

/** The slab and the slit for a mark `height` tall whose top-left is `x, y`. */
export function markRects(height: number, x = 0, y = 0): MarkGeometry {
  const u = height / MARK_UNITS;
  return {
    slab: { x, y, w: MARK_SLAB_U * u, h: height },
    slit: {
      x: x + (MARK_SLAB_U + MARK_GAP_U) * u,
      y,
      w: MARK_SLIT_U * u,
      h: height,
    },
  };
}

/** The app icon: a 64 tile with the mark 36 tall at a 14 inset, square. */
export const APP_ICON = {
  tile: 64,
  inset: 14,
  mark: 36,
  tileFill: "#141414",
  slabFill: "#fafafa",
  slitFill: "#8f8f8f",
} as const;

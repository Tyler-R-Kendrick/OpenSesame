import type { QuietRect } from "./layout.js";

/** How much of a ring survives under the card: the cipher carries on behind
 *  it, dimmed, so the gate's controls read over it and nothing is cut off. */
export const QUIET_RING_KEEP = 0.3;
/** The feathered band (px) over which the rings fade toward the card. */
export const QUIET_FEATHER = 56;
const QUIET_STEPS = 12;

function eraseQuiet(
  g: CanvasRenderingContext2D,
  rect: QuietRect,
  padX: number,
  padY: number,
): void {
  g.clearRect(
    rect.x - padX,
    rect.y - padY,
    rect.w + padX * 2,
    rect.h + padY * 2,
  );
}

/**
 * Dim the rings under a rect with a feathered edge instead of cutting them:
 * stacked erasures, each a step further in, so the keep falls from 1 at the
 * band's outer edge to {@link QUIET_RING_KEEP} at the rect itself.
 */
function fadeQuiet(g: CanvasRenderingContext2D, rect: QuietRect): void {
  const alpha = 1 - QUIET_RING_KEEP ** (1 / QUIET_STEPS);
  g.save();
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = `rgba(0, 0, 0, ${alpha})`;
  for (let i = 0; i < QUIET_STEPS; i += 1) {
    const grow = QUIET_FEATHER * (1 - i / QUIET_STEPS);
    g.fillRect(
      rect.x - grow,
      rect.y - grow,
      rect.w + grow * 2,
      rect.h + grow * 2,
    );
  }
  g.restore();
}

/**
 * Mask for the dial's layers. Black keeps a pixel. The rings (`soft`) fade
 * under the card and carry on behind it; the cipher key's overlay on a phone
 * is cleared outright under the card and the notes, so its readout never sits
 * under text.
 */
export function buildQuietMask(
  w: number,
  h: number,
  quiet: QuietRect[],
  soft = false,
): string {
  const mc = document.createElement("canvas");
  mc.width = Math.round(w);
  mc.height = Math.round(h);
  const mg = mc.getContext("2d");
  if (!mg) return "";
  mg.fillStyle = "#000";
  mg.fillRect(0, 0, w, h);
  if (soft) {
    for (const q of quiet) fadeQuiet(mg, q);
  } else {
    if (quiet[0]) eraseQuiet(mg, quiet[0], 22, 40);
    for (const q of quiet.slice(1)) eraseQuiet(mg, q, 16, 34);
  }
  return `url(${mc.toDataURL()})`;
}

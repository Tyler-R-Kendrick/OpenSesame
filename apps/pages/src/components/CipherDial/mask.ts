import type { QuietRect } from "./layout.js";

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

/** Soft mask: black keeps rings, cleared areas hide them under the card/notes. */
export function buildQuietMask(
  w: number,
  h: number,
  quiet: QuietRect[],
): string {
  const mc = document.createElement("canvas");
  mc.width = Math.round(w);
  mc.height = Math.round(h);
  const mg = mc.getContext("2d");
  if (!mg) return "";
  mg.fillStyle = "#000";
  mg.fillRect(0, 0, w, h);
  if (quiet[0]) eraseQuiet(mg, quiet[0], 22, 40);
  for (const q of quiet.slice(1)) eraseQuiet(mg, q, 16, 34);
  return `url(${mc.toDataURL()})`;
}

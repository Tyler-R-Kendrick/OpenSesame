import { dialNowMs } from "./dial-time.js";
import { drawOrnament } from "./draw-ornament.js";
import { readInkRgb } from "./ink.js";
import type { DialLayout, QuietRect, RingSpec } from "./layout-types.js";
import { computeDialLayout, rectRelative } from "./layout.js";
import { buildQuietMask } from "./mask.js";
import { syncRingCanvasElements } from "./sync-ring-canvases.js";

export type DialDomRefs = {
  pane: HTMLElement;
  card: HTMLElement;
  notes: HTMLElement | null;
  ringLayer: HTMLDivElement | null;
  fixed: HTMLCanvasElement | null;
  overlay: HTMLCanvasElement | null;
  ringCanvasRefs: Map<number, HTMLCanvasElement>;
};

export type RelayoutResult = {
  layout: DialLayout;
  ink: [number, number, number];
  splitX: number;
};

function notesRect(
  paneRect: DOMRect,
  notesEl: HTMLElement | null,
): QuietRect | null {
  if (!notesEl) return null;
  return rectRelative(paneRect, notesEl.getBoundingClientRect());
}

function applyOverlayMask(
  overlay: HTMLCanvasElement,
  layout: DialLayout,
  w: number,
  h: number,
  notesR: QuietRect | null,
): void {
  if (!layout.narrow || !notesR) {
    overlay.style.maskImage = "";
    overlay.style.webkitMaskImage = "";
    overlay.style.maskSize = "";
    overlay.style.webkitMaskSize = "";
    return;
  }
  const mask = buildQuietMask(w, h, [...layout.quiet, notesR]);
  overlay.style.maskImage = mask;
  overlay.style.webkitMaskImage = mask;
  overlay.style.maskSize = `${w}px ${h}px`;
  overlay.style.webkitMaskSize = `${w}px ${h}px`;
}

function applyRingLayerMask(
  layer: HTMLDivElement,
  layout: DialLayout,
  w: number,
  h: number,
  notesR: QuietRect | null,
): void {
  const mask = buildQuietMask(w, h, layout.quiet);
  layer.style.maskImage = mask;
  layer.style.webkitMaskImage = mask;
  layer.style.maskSize = `${w}px ${h}px`;
  layer.style.webkitMaskSize = `${w}px ${h}px`;
  if (!layout.narrow && notesR) {
    // Clip rings at the notes divider (not layout.cx): only the overlay
    // index column may straddle into the release-notes pane (lock-v5).
    layer.style.right = `${Math.max(0, w - notesR.x)}px`;
    layer.style.left = "0";
  } else {
    layer.style.right = "0";
  }
}

function sizePaneCanvas(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  return canvas.getContext("2d");
}

export function measureAndPaintDial(
  refs: DialDomRefs,
  prev?: RingSpec[],
): RelayoutResult | null {
  const paneRect = refs.pane.getBoundingClientRect();
  const w = paneRect.width;
  const h = paneRect.height;
  if (w < 1 || h < 1) return null;

  const narrow = w < 1100;
  const cardR = rectRelative(paneRect, refs.card.getBoundingClientRect());
  const notesR = notesRect(paneRect, refs.notes);

  const layout = computeDialLayout({
    w,
    h,
    card: cardR,
    notes: notesR,
    narrow,
    nowMs: dialNowMs(),
    prev,
  });

  const unlock = refs.pane.closest(".unlock");
  const root = unlock instanceof HTMLElement ? unlock : refs.pane;
  const ink = readInkRgb(root);

  if (refs.ringLayer) {
    applyRingLayerMask(refs.ringLayer, layout, w, h, notesR);
  }

  const splitX = narrow ? w / 2 : (notesR?.x ?? layout.cx);

  if (refs.fixed) {
    const g = sizePaneCanvas(refs.fixed, w, h);
    if (g) drawOrnament(g, layout, ink, "var(--mono)");
  }
  if (refs.overlay) {
    sizePaneCanvas(refs.overlay, w, h);
    applyOverlayMask(refs.overlay, layout, w, h, notesR);
  }

  syncRingCanvasElements(layout, refs.ringCanvasRefs);

  return { layout, ink, splitX };
}

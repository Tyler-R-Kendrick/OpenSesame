import { readCanvas2d } from "./canvas-context.js";
import { slotTimingsJson } from "./cipher-timings.js";
import type { DecryptRun } from "./cipher.js";
import { type Layout, layoutWordmark } from "./particles.js";

const PAD = 4;
const GAP_EM = 0.28;

export function resizeCipherCanvas(args: {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  text: string;
  size: number | undefined;
  includeMark: boolean;
  runs: DecryptRun[];
}): Layout | null {
  const { root, canvas, text, size, includeMark, runs } = args;
  const ctx = readCanvas2d(canvas);
  if (!ctx) {
    root.dataset.cipherTimings = slotTimingsJson(runs);
    return null;
  }
  const emPx =
    size ?? (Number.parseFloat(getComputedStyle(root).fontSize) || 16);
  const layout = layoutWordmark(ctx, [...text], emPx, GAP_EM, PAD, includeMark);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round((layout.W + PAD * 2) * dpr);
  canvas.height = Math.round((layout.H + PAD * 2) * dpr);
  canvas.style.width = `${layout.W + PAD * 2}px`;
  canvas.style.height = `${layout.H + PAD * 2}px`;
  root.dataset.cipherTimings = slotTimingsJson(runs);
  return layout;
}

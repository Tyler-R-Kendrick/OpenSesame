import { readCanvas2d } from "./canvas-context.js";
import { nowMs } from "./cipher-timings.js";
import { type DecryptRun, cursorSlot, isSettled, pruneRuns } from "./cipher.js";
import {
  DRAW_CALIBRATION,
  type Layout,
  drawWordmark,
  readInkRgb,
  readSlit,
  tierOf,
} from "./particles.js";

const PAD = 4;

export function paintCipherFrame(args: {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  layout: Layout;
  runs: DecryptRun[];
  timeMs: number;
  motionOff: boolean;
  settled: boolean;
  includeMark: boolean;
  showCursor: boolean;
}) {
  const {
    root,
    canvas,
    layout,
    timeMs,
    motionOff,
    settled,
    includeMark,
    showCursor,
  } = args;
  const ctx = readCanvas2d(canvas);
  if (!ctx) return { runs: args.runs, justSettled: false as const };
  const runs = pruneRuns(args.runs, timeMs);
  drawWordmark({
    ctx,
    layout,
    runs,
    timeMs,
    dpr: Math.min(window.devicePixelRatio || 1, 3),
    pad: PAD,
    inkRgb: readInkRgb(root),
    calibration: DRAW_CALIBRATION,
    // The field keeps its shimmer after the decode settles; only reduced
    // motion holds it still.
    frozenField: motionOff,
    showMark: includeMark,
    slit: readSlit(root),
    showCursor,
  });
  // The verify harness reads which slot the cursor is on at the injected
  // clock: exactly one while decrypting, none once settled.
  root.dataset.cipherCursor = String(motionOff ? -1 : cursorSlot(runs, timeMs));
  return {
    runs,
    justSettled: (motionOff || isSettled(runs, timeMs)) && !settled,
  };
}

/** The particle tier shimmers for as long as it is on screen. */
export function shimmers(layout: Layout | null): boolean {
  return layout !== null && tierOf(layout.em) === "field";
}

export function scheduleCipherLoop(args: {
  rafRef: { current: number };
  visibleRef: { current: boolean };
  runsRef: { current: DecryptRun[] };
  layoutRef: { current: Layout | null };
  motionOff: boolean;
  paint: (t: number) => void;
}): void {
  const { rafRef, visibleRef, runsRef, layoutRef, motionOff, paint } = args;
  cancelAnimationFrame(rafRef.current);
  const loop = () => {
    if (!visibleRef.current) return;
    const t = nowMs();
    paint(t);
    const decoding = !isSettled(runsRef.current, t);
    if (!motionOff && (decoding || shimmers(layoutRef.current))) {
      rafRef.current = requestAnimationFrame(loop);
    }
  };
  rafRef.current = requestAnimationFrame(loop);
}

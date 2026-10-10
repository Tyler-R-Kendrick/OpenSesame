import { readCanvas2d } from "./canvas-context.js";
import { nowMs } from "./cipher-timings.js";
import { type DecryptRun, cursorSlot, isSettled, pruneRuns } from "./cipher.js";
import {
  DRAW_CALIBRATION,
  type Layout,
  drawWordmark,
  readInkRgb,
  readSlit,
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
    frozenField: motionOff || settled,
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

export function scheduleCipherLoop(args: {
  rafRef: { current: number };
  visibleRef: { current: boolean };
  runsRef: { current: DecryptRun[] };
  motionOff: boolean;
  paint: (t: number) => void;
}): void {
  const { rafRef, visibleRef, runsRef, motionOff, paint } = args;
  cancelAnimationFrame(rafRef.current);
  const loop = () => {
    if (!visibleRef.current) return;
    const t = nowMs();
    paint(t);
    if (!motionOff && !isSettled(runsRef.current, t)) {
      rafRef.current = requestAnimationFrame(loop);
    }
  };
  rafRef.current = requestAnimationFrame(loop);
}

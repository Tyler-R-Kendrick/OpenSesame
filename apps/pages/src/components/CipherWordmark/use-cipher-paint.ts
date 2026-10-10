import { type MutableRefObject, type RefObject, useCallback } from "react";
import { paintCipherFrame, scheduleCipherLoop } from "./cipher-frame.js";
import { resizeCipherCanvas } from "./cipher-resize.js";
import {
  nowMs,
  prefersReducedMotion,
  slotTimingsJson,
} from "./cipher-timings.js";
import type { DecryptRun } from "./cipher.js";
import type { Layout } from "./particles.js";
import { useCipherRuns } from "./use-cipher-runs.js";

export { nowMs, prefersReducedMotion, slotTimingsJson };

type PaintRefs = {
  rootRef: RefObject<HTMLElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  layoutRef: MutableRefObject<Layout | null>;
  runsRef: MutableRefObject<DecryptRun[]>;
  settledRef: MutableRefObject<boolean>;
  visibleRef: MutableRefObject<boolean>;
  rafRef: MutableRefObject<number>;
};

type PaintOpts = {
  text: string;
  size: number | undefined;
  includeMark: boolean;
  showCursor: boolean;
  motionOff: boolean;
  onSettled: (() => void) | undefined;
  setSettled: (v: boolean) => void;
};

export function useCipherPaint(refs: PaintRefs, opts: PaintOpts) {
  const {
    rootRef,
    canvasRef,
    layoutRef,
    runsRef,
    settledRef,
    visibleRef,
    rafRef,
  } = refs;
  const {
    text,
    size,
    includeMark,
    showCursor,
    motionOff,
    onSettled,
    setSettled,
  } = opts;

  const { startRun, settleRun } = useCipherRuns(
    { rootRef, runsRef, settledRef },
    text,
    setSettled,
  );

  const resize = useCallback(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const layout = resizeCipherCanvas({
      root,
      canvas,
      text,
      size,
      includeMark,
      runs: runsRef.current,
    });
    if (layout) layoutRef.current = layout;
  }, [text, size, includeMark, rootRef, canvasRef, layoutRef, runsRef]);

  const paint = useCallback(
    (timeMs: number) => {
      const root = rootRef.current;
      const canvas = canvasRef.current;
      const layout = layoutRef.current;
      if (!root || !canvas || !layout) return;
      const result = paintCipherFrame({
        root,
        canvas,
        layout,
        runs: runsRef.current,
        timeMs,
        motionOff,
        settled: settledRef.current,
        includeMark,
        showCursor,
      });
      runsRef.current = result.runs;
      if (result.justSettled) {
        settledRef.current = true;
        setSettled(true);
        onSettled?.();
      }
    },
    [
      rootRef,
      canvasRef,
      layoutRef,
      runsRef,
      settledRef,
      motionOff,
      onSettled,
      showCursor,
      includeMark,
      setSettled,
    ],
  );

  const scheduleFrame = useCallback(() => {
    scheduleCipherLoop({
      rafRef,
      visibleRef,
      runsRef,
      motionOff,
      paint,
    });
  }, [motionOff, paint, rafRef, runsRef, visibleRef]);

  return { startRun, settleRun, resize, paint, scheduleFrame };
}

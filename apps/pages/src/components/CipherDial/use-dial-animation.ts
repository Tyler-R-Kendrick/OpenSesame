import { type RefObject, useEffect } from "react";
import type { CipherDialPhase } from "./CipherDial.js";
import { dialNowMs, dialPrefersReducedMotion } from "./dial-time.js";
import type { DialLayout } from "./layout-types.js";
import { paintDialAnimatedFrame } from "./paint-dial-frame.js";
import { paintDialStaticFrame } from "./paint-dial-static.js";

export function useDialAnimation(input: {
  layoutRef: RefObject<DialLayout | null>;
  ringCanvasRefs: RefObject<Map<number, HTMLCanvasElement>>;
  overlayRef: RefObject<HTMLCanvasElement | null>;
  inkRef: RefObject<[number, number, number]>;
  phase: CipherDialPhase;
  lit: number;
  reducedMotion?: boolean;
}): void {
  const {
    layoutRef,
    ringCanvasRefs,
    overlayRef,
    inkRef,
    phase,
    lit,
    reducedMotion,
  } = input;

  useEffect(() => {
    const reduce = reducedMotion ?? dialPrefersReducedMotion();
    const layout = layoutRef.current;
    if (reduce) {
      if (!layout) return;
      paintDialStaticFrame({
        layout,
        rings: layout.rings,
        lit,
        ink: inkRef.current,
        ringCanvasRefs: ringCanvasRefs.current,
        overlay: overlayRef.current,
      });
      return;
    }

    let frame = 0;
    const loop = () => {
      const live = layoutRef.current;
      if (!live) {
        frame = requestAnimationFrame(loop);
        return;
      }
      paintDialAnimatedFrame({
        layout: live,
        phase,
        lit,
        ink: inkRef.current,
        t: dialNowMs(),
        ringCanvasRefs: ringCanvasRefs.current,
        overlay: overlayRef.current,
      });
      if (phase !== "open") frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [
    inkRef,
    layoutRef,
    lit,
    overlayRef,
    phase,
    reducedMotion,
    ringCanvasRefs,
  ]);
}

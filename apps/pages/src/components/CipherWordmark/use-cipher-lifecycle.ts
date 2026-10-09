import { type RefObject, useEffect } from "react";
import { nowMs } from "./use-cipher-paint.js";

type LifecycleArgs = {
  rootRef: RefObject<HTMLElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  visibleRef: { current: boolean };
  rafRef: { current: number };
  resize: () => void;
  paint: (t: number) => void;
  scheduleFrame: () => void;
};

/** Resize, intersection, and tab-visibility observers for the cipher canvas. */
export function useCipherLifecycle({
  rootRef,
  canvasRef,
  visibleRef,
  rafRef,
  resize,
  paint,
  scheduleFrame,
}: LifecycleArgs): void {
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            resize();
            paint(nowMs());
          })
        : null;
    ro?.observe(root);
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            visibleRef.current = entries[0]?.isIntersecting ?? true;
            if (visibleRef.current) scheduleFrame();
          })
        : null;
    io?.observe(canvas);
    const onVis = () => {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) scheduleFrame();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cancelAnimationFrame(rafRef.current);
    };
  }, [rootRef, canvasRef, visibleRef, rafRef, resize, paint, scheduleFrame]);
}

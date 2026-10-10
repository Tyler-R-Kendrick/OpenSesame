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
      globalThis.ResizeObserver === undefined
        ? null
        : new ResizeObserver(() => {
            resize();
            paint(nowMs());
          });
    ro?.observe(root);
    const io =
      globalThis.IntersectionObserver === undefined
        ? null
        : new IntersectionObserver((entries) => {
            visibleRef.current = entries[0]?.isIntersecting ?? true;
            if (visibleRef.current) scheduleFrame();
          });
    io?.observe(canvas);
    const onVis = () => {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) scheduleFrame();
    };
    document.addEventListener("visibilitychange", onVis);
    // verify:static / Settings theme flips `data-theme` without resizing;
    // re-read ink and repaint so dark plates get light ink.
    const onTheme = () => {
      resize();
      paint(nowMs());
      if (visibleRef.current) scheduleFrame();
    };
    const mo =
      globalThis.MutationObserver === undefined
        ? null
        : new MutationObserver(onTheme);
    mo?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      ro?.disconnect();
      io?.disconnect();
      mo?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cancelAnimationFrame(rafRef.current);
    };
  }, [rootRef, canvasRef, visibleRef, rafRef, resize, paint, scheduleFrame]);
}

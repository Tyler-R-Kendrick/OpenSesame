import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Box, Size } from "./placement.js";

function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/**
 * The live rectangle of whatever `resolve` returns, one frame behind at most.
 *
 * The target moves for reasons a component cannot subscribe to — a pane
 * scrolls, a sheet slides in, a list reflows when the vault finishes loading
 * — so the rectangle is read each frame and a change is published only when
 * it is at least half a pixel. A tour is on screen for seconds, and the read
 * is one `getBoundingClientRect`; polling is the honest design here.
 */
export function useLiveRect(resolve: () => HTMLElement | null): Box | null {
  const [rect, setRect] = useState<Box | null>(null);
  const latest = useRef(resolve);
  latest.current = resolve;
  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      const element = latest.current();
      const box = element?.getBoundingClientRect();
      const next: Box | null =
        box && (box.width > 0 || box.height > 0)
          ? {
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
            }
          : null;
      setRect((held) => (sameBox(held, next) ? held : next));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, []);
  return rect;
}

const readViewport = (): Size => ({
  width: document.documentElement.clientWidth,
  height: window.visualViewport?.height ?? window.innerHeight,
});

/** The visual viewport's size, following rotation and the on-screen keyboard. */
export function useViewport(): Size {
  const [size, setSize] = useState<Size>(readViewport);
  useEffect(() => {
    const update = (): void => {
      setSize((held) => {
        const next = readViewport();
        return held.width === next.width && held.height === next.height
          ? held
          : next;
      });
    };
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);
  return size;
}

/** Whether the shell is drawing its phone layout (DESIGN.md § Touch). */
export function usePhoneLayout(): boolean {
  const query = "(max-width: 900px), (pointer: coarse)";
  const [phone, setPhone] = useState(
    () => globalThis.matchMedia?.(query).matches ?? false,
  );
  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) return;
    const update = (): void => setPhone(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, []);
  return phone;
}

/** The measured size of an element, kept current as its content changes. */
export function useMeasured(
  ref: React.RefObject<HTMLElement | null>,
  watch: string,
): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `watch` re-measures when the step's content changes.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (): void => {
      const box = node.getBoundingClientRect();
      setSize((held) =>
        held &&
        Math.abs(held.width - box.width) < 0.5 &&
        Math.abs(held.height - box.height) < 0.5
          ? held
          : { width: box.width, height: box.height },
      );
    };
    measure();
    if (!("ResizeObserver" in globalThis)) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, watch]);
  return size;
}

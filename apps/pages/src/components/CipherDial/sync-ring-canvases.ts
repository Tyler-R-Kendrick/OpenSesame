import type { DialLayout } from "./layout-types.js";

export function syncRingCanvasElements(
  layout: DialLayout,
  ringCanvasRefs: Map<number, HTMLCanvasElement>,
): void {
  ringCanvasRefs.forEach((cv, i) => {
    const q = layout.rings[i];
    if (!q || !cv) return;
    const bw = q.bx1 - q.bx0;
    const bh = q.by1 - q.by0;
    if (bw <= 0 || bh <= 0) {
      cv.style.display = "none";
      return;
    }
    cv.style.display = "block";
    cv.style.left = `${q.bx0}px`;
    cv.style.top = `${q.by0}px`;
    cv.style.width = `${bw}px`;
    cv.style.height = `${bh}px`;
    cv.width = Math.round(bw * (window.devicePixelRatio || 1));
    cv.height = Math.round(bh * (window.devicePixelRatio || 1));
  });
}

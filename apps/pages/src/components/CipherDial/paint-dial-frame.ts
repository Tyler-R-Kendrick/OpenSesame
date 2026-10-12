import type { CipherDialPhase } from "./cipher-dial-phase.js";
import { drawOverlay, paintRingLayer } from "./draw-rings.js";
import type { DialLayout } from "./layout-types.js";
import { ringPosition, tickIdleRing } from "./ring-motion.js";

export function paintDialAnimatedFrame(input: {
  layout: DialLayout;
  phase: CipherDialPhase;
  lit: number;
  ink: [number, number, number];
  t: number;
  ringCanvasRefs: Map<number, HTMLCanvasElement>;
  overlay: HTMLCanvasElement | null;
}): boolean {
  const { layout, phase, lit, ink, t, ringCanvasRefs, overlay } = input;
  const d = window.devicePixelRatio || 1;
  let any = false;
  for (const q of layout.rings) {
    if (phase === "idle") tickIdleRing(q, t, phase);
    const k = ringPosition(q, t);
    if (q.t0 >= 0 || q.dirty || q.lastK !== k || q.lastLit !== lit) {
      const cv = ringCanvasRefs.get(q.i);
      const g = cv?.getContext("2d");
      if (g) paintRingLayer(g, layout, q, k, ink, d);
      q.lastLit = lit;
      q.dirty = false;
      any = true;
    }
  }
  if (any || phase !== "idle") {
    const og = overlay?.getContext("2d");
    if (og) drawOverlay(og, layout, layout.rings, lit, ink, d);
  }
  return any;
}

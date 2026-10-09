import { type RefObject, useCallback, useEffect, useRef } from "react";
import { RING_KEYS, T_CLICK_MS } from "./constants.js";
import { drawOrnament } from "./draw-ornament.js";
import { drawOverlay, paintRingLayer } from "./draw-rings.js";
import { readInkRgb as readInkLocal } from "./ink.js";
import { type DialLayout, computeDialLayout, rectRelative } from "./layout.js";
import { buildQuietMask } from "./mask.js";
import { alignRings, ringPosition, tickIdleRing } from "./ring-motion.js";
import "./cipher-dial.css";

export type CipherDialPhase = "idle" | "align" | "open";

export type CipherDialProps = {
  paneRef: RefObject<HTMLElement | null>;
  cardRef: RefObject<HTMLElement | null>;
  notesRef: RefObject<HTMLElement | null>;
  phase: CipherDialPhase;
  alignStartMs: number | null;
  lit: number;
  reducedMotion?: boolean;
  onSplitX?: (x: number) => void;
};

function nowMs(): number {
  const w = globalThis as { __vt?: number };
  if (typeof w.__vt === "number") return w.__vt;
  return performance.now();
}

function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== "function") return false;
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function CipherDial({
  paneRef,
  cardRef,
  notesRef,
  phase,
  alignStartMs,
  lit,
  reducedMotion,
  onSplitX,
}: CipherDialProps) {
  const fixedRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const ringLayerRef = useRef<HTMLDivElement>(null);
  const ringCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const layoutRef = useRef<DialLayout | null>(null);
  const inkRef = useRef<[number, number, number]>([15, 15, 15]);

  const relayout = useCallback(() => {
    const pane = paneRef.current;
    const card = cardRef.current;
    if (!pane || !card) return;
    const paneRect = pane.getBoundingClientRect();
    const w = paneRect.width;
    const h = paneRect.height;
    if (w < 1 || h < 1) return;
    const narrow = w < 1100;
    const cardR = rectRelative(paneRect, card.getBoundingClientRect());
    const notesEl = notesRef.current;
    const notesR =
      notesEl && !narrow
        ? rectRelative(paneRect, notesEl.getBoundingClientRect())
        : notesEl
          ? rectRelative(paneRect, notesEl.getBoundingClientRect())
          : null;
    const prev = layoutRef.current?.rings;
    const layout = computeDialLayout({
      w,
      h,
      card: cardR,
      notes: notesR,
      narrow,
      nowMs: nowMs(),
      prev,
    });
    layoutRef.current = layout;
    const root = pane.closest(".unlock") ?? pane;
    inkRef.current = readInkLocal(root as HTMLElement);
    const layer = ringLayerRef.current;
    if (layer) {
      const mask = buildQuietMask(w, h, layout.quiet);
      layer.style.maskImage = mask;
      layer.style.webkitMaskImage = mask;
      layer.style.maskSize = `${w}px ${h}px`;
      layer.style.webkitMaskSize = `${w}px ${h}px`;
      if (!narrow && notesR) {
        layer.style.right = `${Math.max(0, w - layout.cx)}px`;
        layer.style.left = "0";
      } else {
        layer.style.right = "0";
      }
    }

    const splitX = narrow ? w / 2 : (notesR?.x ?? layout.cx);
    onSplitX?.(splitX);

    const fixed = fixedRef.current;
    const overlay = overlayRef.current;
    if (fixed) {
      fixed.width = Math.round(w * (window.devicePixelRatio || 1));
      fixed.height = Math.round(h * (window.devicePixelRatio || 1));
      fixed.style.width = `${w}px`;
      fixed.style.height = `${h}px`;
      const g = fixed.getContext("2d");
      if (g) {
        drawOrnament(g, layout, inkRef.current, "var(--mono)");
      }
    }
    if (overlay) {
      overlay.width = Math.round(w * (window.devicePixelRatio || 1));
      overlay.height = Math.round(h * (window.devicePixelRatio || 1));
      overlay.style.width = `${w}px`;
      overlay.style.height = `${h}px`;
    }

    ringCanvasRefs.current.forEach((cv, i) => {
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
  }, [cardRef, notesRef, onSplitX, paneRef]);

  useEffect(() => {
    relayout();
    const pane = paneRef.current;
    if (!pane) return;
    if (typeof ResizeObserver === "undefined") {
      const onResize = () => relayout();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const ro = new ResizeObserver(() => relayout());
    ro.observe(pane);
    if (cardRef.current) ro.observe(cardRef.current);
    if (notesRef.current) ro.observe(notesRef.current);
    return () => ro.disconnect();
  }, [cardRef, notesRef, paneRef, relayout]);

  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || phase !== "align" || alignStartMs === null) return;
    alignRings(layout.rings, alignStartMs, T_CLICK_MS);
  }, [alignStartMs, phase]);

  useEffect(() => {
    const reduce = reducedMotion ?? prefersReducedMotion();
    if (reduce) {
      const layout = layoutRef.current;
      if (!layout) return;
      const d = window.devicePixelRatio || 1;
      for (const q of layout.rings) {
        const cv = ringCanvasRefs.current.get(q.i);
        const g = cv?.getContext("2d");
        if (g) paintRingLayer(g, layout, q, q.to, inkRef.current, d);
      }
      const og = overlayRef.current?.getContext("2d");
      if (og) drawOverlay(og, layout, layout.rings, lit, inkRef.current, d);
      return;
    }

    let frame = 0;
    const loop = () => {
      const layout = layoutRef.current;
      if (!layout) {
        frame = requestAnimationFrame(loop);
        return;
      }
      const t = nowMs();
      const d = window.devicePixelRatio || 1;
      let any = false;
      for (const q of layout.rings) {
        if (phase === "idle") tickIdleRing(q, t, phase);
        const k = ringPosition(q, t);
        if (q.t0 >= 0 || q.dirty || q.lastK !== k || q.lastLit !== lit) {
          const cv = ringCanvasRefs.current.get(q.i);
          const g = cv?.getContext("2d");
          if (g) paintRingLayer(g, layout, q, k, inkRef.current, d);
          q.lastLit = lit;
          q.dirty = false;
          any = true;
        }
      }
      if (any || phase !== "idle") {
        const og = overlayRef.current?.getContext("2d");
        if (og) drawOverlay(og, layout, layout.rings, lit, inkRef.current, d);
      }
      if (phase !== "open") frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [lit, phase, reducedMotion]);

  return (
    <div className="cipher-dial" aria-hidden="true">
      <div className="cipher-dial__rings" ref={ringLayerRef}>
        <canvas ref={fixedRef} className="cipher-dial__fixed" />
        {RING_KEYS.map((ringKey, i) => (
          <canvas
            key={ringKey}
            ref={(el) => {
              if (el) ringCanvasRefs.current.set(i, el);
              else ringCanvasRefs.current.delete(i);
            }}
            className="cipher-dial__ring"
          />
        ))}
      </div>
      <canvas ref={overlayRef} className="cipher-dial__overlay" />
    </div>
  );
}

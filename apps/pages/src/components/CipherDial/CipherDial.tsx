import { type RefObject, useRef } from "react";
import type { CipherDialPhase } from "./cipher-dial-phase.js";
import { RING_KEYS } from "./constants.js";
import type { DialLayout } from "./layout-types.js";
import { useDialAlign } from "./use-dial-align.js";
import { useDialAnimation } from "./use-dial-animation.js";
import { useDialRelayout } from "./use-dial-relayout.js";
import { useDialResize } from "./use-dial-resize.js";
import "./cipher-dial.css";

export type { CipherDialPhase } from "./cipher-dial-phase.js";

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

  const relayout = useDialRelayout({
    paneRef,
    cardRef,
    notesRef,
    fixedRef,
    overlayRef,
    ringLayerRef,
    ringCanvasRefs,
    layoutRef,
    inkRef,
    onSplitX,
  });

  useDialResize(paneRef, cardRef, notesRef, relayout);
  useDialAlign(layoutRef, phase, alignStartMs);
  useDialAnimation({
    layoutRef,
    ringCanvasRefs,
    overlayRef,
    inkRef,
    phase,
    lit,
    reducedMotion,
  });

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

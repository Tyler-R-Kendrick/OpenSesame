import { type RefObject, useEffect, useState } from "react";
import { T_END_MS, T_OPEN_MS } from "../CipherDial/constants.js";
import { doorEase } from "../CipherDial/easing.js";
import "./vault-doors.css";

export type VaultDoorsProps = {
  active: boolean;
  openStartMs: number | null;
  splitX: number;
  paneRef: RefObject<HTMLElement | null>;
  reducedMotion?: boolean;
  onComplete: () => void;
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

export function VaultDoors({
  active,
  openStartMs,
  splitX,
  paneRef,
  reducedMotion,
  onComplete,
}: VaultDoorsProps) {
  const [progress, setProgress] = useState(0);
  const reduce = reducedMotion ?? prefersReducedMotion();

  useEffect(() => {
    if (!active) {
      setProgress(0);
      return;
    }
    if (reduce) {
      setProgress(1);
      const id = window.setTimeout(onComplete, 180);
      return () => clearTimeout(id);
    }
    if (openStartMs === null) return;
    let frame = 0;
    const tick = () => {
      const u = Math.min(
        1,
        Math.max(0, (nowMs() - openStartMs) / (T_END_MS - T_OPEN_MS)),
      );
      setProgress(doorEase(u));
      if (u >= 1) {
        onComplete();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, onComplete, openStartMs, reduce]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const unlock = pane.closest(".unlock");
    if (!unlock) return;
    if (!active) {
      unlock.classList.remove("unlock--doors");
      unlock.style.removeProperty("--unlock-door-shift");
      unlock.style.removeProperty("--unlock-door-split");
      return;
    }
    unlock.classList.add("unlock--doors");
    unlock.style.setProperty("--unlock-door-split", `${splitX}px`);
    unlock.style.setProperty("--unlock-door-shift", `${progress * 102}%`);
    return () => {
      unlock.classList.remove("unlock--doors");
      unlock.style.removeProperty("--unlock-door-shift");
      unlock.style.removeProperty("--unlock-door-split");
    };
  }, [active, paneRef, progress, splitX]);

  if (!active) return null;

  if (reduce) {
    return <div className="vault-doors vault-doors--fade" aria-hidden="true" />;
  }

  return (
    <>
      <div
        className="vault-doors__seam vault-doors__seam--left"
        style={{
          left: `calc(var(--unlock-door-split, ${splitX}px) - 1px)`,
          opacity: 0.55 * (1 - progress * 0.6),
        }}
        aria-hidden="true"
      />
      <div
        className="vault-doors__seam vault-doors__seam--right"
        style={{
          left: `var(--unlock-door-split, ${splitX}px)`,
          opacity: 0.55 * (1 - progress * 0.6),
        }}
        aria-hidden="true"
      />
    </>
  );
}

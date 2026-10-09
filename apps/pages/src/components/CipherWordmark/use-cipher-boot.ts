import { type MutableRefObject, useEffect } from "react";
import type { DecryptRun } from "./cipher.js";
import { nowMs } from "./use-cipher-paint.js";

type BootArgs = {
  motionOff: boolean;
  animateOnMount: boolean;
  replayProp: boolean;
  runsRef: MutableRefObject<DecryptRun[]>;
  settledRef: MutableRefObject<boolean>;
  setSettled: (v: boolean) => void;
  startRun: () => void;
  resize: () => void;
  paint: (t: number) => void;
  scheduleFrame: () => void;
};

/** Mount / prop-driven start of a decrypt run (or static settle). */
export function useCipherBoot({
  motionOff,
  animateOnMount,
  replayProp,
  runsRef,
  settledRef,
  setSettled,
  startRun,
  resize,
  paint,
  scheduleFrame,
}: BootArgs): void {
  useEffect(() => {
    if (motionOff) {
      runsRef.current = [];
      settledRef.current = true;
      setSettled(true);
      resize();
      paint(nowMs());
      return;
    }
    if (animateOnMount || replayProp) startRun();
    else {
      runsRef.current = [];
      settledRef.current = true;
      setSettled(true);
    }
    resize();
    scheduleFrame();
  }, [
    animateOnMount,
    motionOff,
    paint,
    replayProp,
    resize,
    scheduleFrame,
    startRun,
    runsRef,
    settledRef,
    setSettled,
  ]);
}

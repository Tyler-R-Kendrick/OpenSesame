import { useEffect } from "react";
import { nowMs } from "./use-cipher-paint.js";

type BootArgs = {
  motionOff: boolean;
  animateOnMount: boolean;
  replayProp: boolean;
  startRun: () => void;
  settleRun: () => void;
  resize: () => void;
  paint: (t: number) => void;
  scheduleFrame: () => void;
};

/** Mount / prop-driven start of a decrypt run (or static settle). */
export function useCipherBoot({
  motionOff,
  animateOnMount,
  replayProp,
  startRun,
  settleRun,
  resize,
  paint,
  scheduleFrame,
}: BootArgs): void {
  useEffect(() => {
    if (motionOff) {
      settleRun();
      resize();
      paint(nowMs());
      return;
    }
    if (animateOnMount || replayProp) startRun();
    else settleRun();
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
    settleRun,
  ]);
}

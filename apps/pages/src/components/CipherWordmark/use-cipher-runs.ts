import { type MutableRefObject, type RefObject, useCallback } from "react";
import { nowMs, slotTimingsJson } from "./cipher-timings.js";
import { type DecryptRun, createSlotRuns } from "./cipher.js";

type RunRefs = {
  rootRef: RefObject<HTMLElement | null>;
  runsRef: MutableRefObject<DecryptRun[]>;
  settledRef: MutableRefObject<boolean>;
};

/** The decrypt runs: start one, or stand on the letters without one. */
export function useCipherRuns(
  refs: RunRefs,
  text: string,
  setSettled: (v: boolean) => void,
) {
  const { rootRef, runsRef, settledRef } = refs;

  const publish = useCallback(
    (runs: DecryptRun[], settled: boolean) => {
      runsRef.current = runs;
      settledRef.current = settled;
      setSettled(settled);
      if (rootRef.current) {
        rootRef.current.dataset.cipherTimings = slotTimingsJson(runs);
        // The run's clock origin, so a harness can pin `__vt` inside it.
        rootRef.current.dataset.cipherStart = String(runs[0]?.t0 ?? 0);
      }
    },
    [rootRef, runsRef, settledRef, setSettled],
  );

  const startRun = useCallback(() => {
    publish(
      [{ t0: nowMs(), slots: createSlotRuns([...text], Math.random) }],
      false,
    );
  }, [text, publish]);

  /**
   * Stand on the letters without a decrypt: a run of zero steps, so a
   * settled or reduced-motion mount still knows each slot's letter (a redraw
   * with no run would find no glyph and paint the mark alone).
   */
  const settleRun = useCallback(() => {
    publish(
      [{ t0: nowMs(), slots: createSlotRuns([...text], Math.random, 0) }],
      true,
    );
  }, [text, publish]);

  return { startRun, settleRun };
}

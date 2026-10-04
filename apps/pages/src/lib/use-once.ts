import { useCallback, useRef } from "react";

/**
 * A function that runs its body at most once, however many times it is called.
 *
 * The guard is a ref set before anything is awaited. State read from a closure
 * is the render's, so two presses that land before the next render both see
 * the old value; a ref is the one thing they share. What this is for is a
 * decision that must be recorded once — a refusal, a withdrawal — whatever the
 * fingers do while the first one is still being written down.
 */
export function useOnce(run: () => Promise<void>): () => Promise<void> {
  const done = useRef(false);
  const latest = useRef(run);
  latest.current = run;
  return useCallback(async () => {
    if (done.current) return;
    done.current = true;
    await latest.current();
  }, []);
}

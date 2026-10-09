import { type DecryptRun, FRAME_MS } from "./cipher.js";

export function slotTimingsJson(runs: DecryptRun[]): string {
  const slots = runs[0]?.slots ?? [];
  return JSON.stringify(
    slots.map((s) => ({
      delay: s.delay * FRAME_MS,
      duration: s.duration * FRAME_MS,
      steps: s.steps,
      letter: s.letter,
    })),
  );
}

export function nowMs(): number {
  // SAFETY: verify:static / wordmark-contract injects `__vt` for mid-decrypt sampling.
  const w = globalThis as { __vt?: number };
  if (typeof w.__vt === "number") return w.__vt;
  return performance.now();
}

export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== "function") return false;
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

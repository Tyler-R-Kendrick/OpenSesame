import {
  injectedNowMs,
  prefersReducedMotion,
} from "../../lib/injected-clock.js";
import { type DecryptRun, FRAME_MS } from "./cipher.js";

export { injectedNowMs as nowMs, prefersReducedMotion };

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

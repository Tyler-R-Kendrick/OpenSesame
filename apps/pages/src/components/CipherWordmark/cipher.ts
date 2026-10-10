/** Uppercase hex — the digest alphabet for the decrypt reel. */
export const CIPHER = "0123456789ABCDEF";

export const MIN_STEPS = 6;
export const MAX_STEPS = 12;
export const FRAME_MS = 35;

/** Visual line on punched plates (lock-v5). */
export const DISPLAY_WORD = "0PEN SESAME";

/**
 * Deterministic mixed scramble + target (lock-v5). Knuth seed, NR LCG, output
 * mix so adjacent slots do not march 012345… on the high nibble alone.
 */
export function cipherReel(
  index: number,
  target: string,
  steps: number,
): string {
  let seed = ((index + 1) * 2_654_435_761) >>> 0;
  let out = "";
  for (let step = 0; step < steps; step += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    let x = seed ^ (seed >>> 15);
    x = Math.imul(x, 0x2c1b3c6d);
    x ^= x >>> 12;
    out += CIPHER[(x >>> 28) & 15] ?? "0";
  }
  return `${out}${target}`;
}

export type SlotRun = {
  index: number;
  delay: number;
  duration: number;
  steps: number;
  reel: string;
  letter: string;
};

export function createSlotRuns(
  letters: readonly string[],
  random: () => number,
  fixedSteps?: number,
): SlotRun[] {
  let locked = 0;
  return letters.map((letter, index) => {
    const advance =
      letter === " "
        ? 0
        : (fixedSteps ??
          MIN_STEPS + Math.floor(random() * (MAX_STEPS - MIN_STEPS + 1)));
    const steps = locked + advance;
    const run: SlotRun = {
      index,
      delay: locked,
      duration: advance,
      steps,
      reel: cipherReel(index, letter, steps),
      letter,
    };
    locked += advance;
    return run;
  });
}

export type SlotFrame = {
  glyph: string;
  /** True while this cell is the active decrypt cursor (brightness plate). */
  cursor: boolean;
  frame: number;
};

export type DecryptRun = {
  t0: number;
  slots: SlotRun[];
};

export function slotState(
  runs: DecryptRun[],
  slotIndex: number,
  timeMs: number,
): SlotFrame {
  const letter = runs[0]?.slots[slotIndex]?.letter ?? " ";
  for (const run of runs) {
    const slot = run.slots[slotIndex];
    if (!slot) continue;
    const frame = Math.floor((timeMs - run.t0) / FRAME_MS);
    if (frame >= slot.steps) continue;
    return {
      glyph: slot.reel[Math.max(0, frame)] ?? letter,
      cursor: frame >= slot.delay && frame < slot.delay + slot.duration,
      frame,
    };
  }
  return { glyph: letter, cursor: false, frame: -1 };
}

export function pruneRuns(runs: DecryptRun[], timeMs: number): DecryptRun[] {
  const live = runs.filter((run) =>
    run.slots.some((s) => timeMs - run.t0 < s.steps * FRAME_MS + FRAME_MS),
  );
  if (live.length > 0) return live;
  // Keep the newest completed run so a settled redraw (theme flip, resize)
  // still knows each slot's target glyph — otherwise paint clears to mark-only.
  return runs.length > 0 ? [runs[runs.length - 1]] : [];
}

export function isSettled(runs: DecryptRun[], timeMs: number): boolean {
  if (runs.length === 0) return true;
  return runs.every((run) =>
    run.slots.every((s) => timeMs - run.t0 >= s.steps * FRAME_MS),
  );
}

/**
 * Deadline sources for the guide runtime.
 *
 * Both honour the port contract exactly: `after` resolves once the deadline
 * passes, and an aborted deadline settles never — the runtime races it against
 * an observation and abandons the loser, so a promise that stayed pending is
 * the correct outcome, not a leak.
 */

import type { GuideClock } from "./ports.js";

/** The browser/Node clock. Clears its timer the moment the wait is abandoned. */
export function systemGuideClock(): GuideClock {
  return {
    after(ms: number, signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve) => {
        if (signal.aborted) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onAbort = (): void => {
          if (timer !== null) clearTimeout(timer);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
      });
    },
  };
}

type TestTimer = {
  readonly at: number;
  readonly resolve: () => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
};

export type TestGuideClock = GuideClock & {
  /**
   * Move the clock forward and let every continuation the runtime chained
   * behind a deadline run before returning, so a test can assert on settled
   * state without sleeping.
   */
  advance(ms: number): Promise<void>;
  /** Deadlines still armed. Zero after a settled run is the leak assertion. */
  pending(): number;
  now(): number;
};

/**
 * Fired deadlines resolve on the microtask queue, and the runtime chains a
 * handful of continuations behind each one (race, wait cleanup, the execution
 * loop, the caller's outcome). Yielding this many turns drains that chain.
 */
const DRAIN_TURNS = 16;

export function createTestClock(): TestGuideClock {
  const timers = new Set<TestTimer>();
  let now = 0;

  return {
    after(ms: number, signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve) => {
        if (signal.aborted) return;
        let timer: TestTimer | null = null;
        const onAbort = (): void => {
          if (timer !== null) timers.delete(timer);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        timer = { at: now + ms, resolve, signal, onAbort };
        timers.add(timer);
      });
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(timer);
        timer.signal.removeEventListener("abort", timer.onAbort);
        timer.resolve();
      }
      for (let turn = 0; turn < DRAIN_TURNS; turn += 1) {
        await Promise.resolve();
      }
    },
    pending: () => timers.size,
    now: () => now,
  };
}

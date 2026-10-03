/**
 * Test clock for live sessions: fake timers, real turns of the event loop —
 * the crypto under the pairing codes is real and settles off the timer queue.
 */
import { vi } from "vitest";

const realSetTimeout = globalThis.setTimeout;

/** What `vi.useFakeTimers` fakes: clocks, never `setImmediate` or microtasks. */
export const FAKE_CLOCK = {
  toFake: [
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "Date",
  ],
} satisfies Parameters<typeof vi.useFakeTimers>[0];

/** Let everything already started finish, under fake timers or real ones. */
export async function settle(rounds = 50): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    if (vi.isFakeTimers()) {
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      await vi.advanceTimersByTimeAsync(0);
    } else await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise a test settles by hand. */
export function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

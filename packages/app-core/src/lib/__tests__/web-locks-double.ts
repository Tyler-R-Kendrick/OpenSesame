/**
 * A faithful `navigator.locks` for tests: exclusive per name, FIFO, the next
 * holder runs only after the previous callback settles. It records every
 * request so a test can prove a section ran under the lock it names, and how
 * many holders were ever inside one name at once (it must be one).
 */

export type WebLocksDouble = {
  request<T>(name: string, run: () => Promise<T>): Promise<T>;
  /** Names requested, in order. */
  readonly requested: string[];
  /** The most holders ever inside one name together. */
  readonly peak: () => number;
};

export function webLocksDouble(): WebLocksDouble {
  const tails = new Map<string, Promise<void>>();
  const inside = new Map<string, number>();
  const requested: string[] = [];
  let peak = 0;
  return {
    requested,
    peak: () => peak,
    async request<T>(name: string, run: () => Promise<T>): Promise<T> {
      requested.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(
        name,
        previous.then(() => gate),
      );
      await previous;
      inside.set(name, (inside.get(name) ?? 0) + 1);
      peak = Math.max(peak, inside.get(name) ?? 0);
      try {
        return await run();
      } finally {
        inside.set(name, (inside.get(name) ?? 1) - 1);
        release();
      }
    },
  };
}

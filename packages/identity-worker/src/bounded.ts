/**
 * Bounds on how long and how wide one dispatch pass may run.
 *
 * The dispatcher used to await every due delivery in turn, and every send may
 * wait out a provider timeout. A registered webhook or a push subscription
 * that never answers is therefore a tax on every tenant: one person pointing a
 * few of them at a black hole stalls the outbox for everyone. The pass is
 * bounded three ways instead:
 *
 * - `DELIVERY_CONCURRENCY` rows in flight at once, so a slow receiver delays a
 *   slot, not the queue;
 * - at most `DELIVERY_PER_PRINCIPAL` of those for one principal, so one
 *   person's receivers cannot take every slot;
 * - `DELIVERY_DEADLINE_MS` for one row, however many sends it holds.
 *
 * The longest pass is `ceil(limit / concurrency) * deadline` (about 140 s for
 * the default 50 rows), and `DELIVERY_LEASE_MS` is longer than that with room
 * to spare, so a row a slow pass is still waiting to start is never claimed by
 * somebody else meanwhile.
 */

export const DELIVERY_CONCURRENCY = 8;
export const DELIVERY_PER_PRINCIPAL = 2;
export const DELIVERY_DEADLINE_MS = 20_000;
export const DEFAULT_CLAIM_LIMIT = 50;

/** The longest one dispatch pass can take. */
export function worstCasePassMs(
  limit: number = DEFAULT_CLAIM_LIMIT,
  concurrency: number = DELIVERY_CONCURRENCY,
  deadlineMs: number = DELIVERY_DEADLINE_MS,
): number {
  return Math.ceil(limit / concurrency) * deadlineMs;
}

export class DeliveryDeadlineError extends Error {
  override readonly name = "DeliveryDeadlineError";
}

/**
 * `work`, or a `DeliveryDeadlineError` once `ms` have passed. The work itself
 * cannot be cancelled from here and carries its own transport timeout; what is
 * bounded is how long the pass waits for it.
 */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeliveryDeadlineError()), ms);
  });
  // The loser of the race must not surface as an unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

export interface BoundedOptions<T> {
  concurrency: number;
  /** Rows sharing a key hold at most `perKey` slots between them. */
  keyOf: (item: T) => string;
  perKey: number;
}

/**
 * Run `fn` over `items`, `concurrency` at a time and `perKey` per key, starting
 * them in order whenever a slot and the key's quota are free. Every item runs
 * even if one throws; the first error is rethrown once the pass has drained, as
 * the sequential loop it replaces would have thrown it.
 */
export async function mapBounded<T>(
  items: readonly T[],
  options: BoundedOptions<T>,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const running = new Map<string, number>();
  let active = 0;
  const failures: Error[] = [];
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (active < options.concurrency) {
        const index = queue.findIndex(
          (item) => (running.get(options.keyOf(item)) ?? 0) < options.perKey,
        );
        const next = index < 0 ? undefined : queue.splice(index, 1)[0];
        if (next === undefined) break;
        const key = options.keyOf(next);
        running.set(key, (running.get(key) ?? 0) + 1);
        active += 1;
        fn(next)
          .catch((error: Error) => {
            failures.push(error);
          })
          .finally(() => {
            running.set(key, (running.get(key) ?? 1) - 1);
            active -= 1;
            pump();
          });
      }
      if (active === 0 && queue.length === 0) resolve();
    };
    pump();
  });
  const [first] = failures;
  if (first) throw first;
}

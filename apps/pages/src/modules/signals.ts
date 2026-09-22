/**
 * Lease-fenced work. An unlock effect or a resumed callback runs under two
 * signals — the capability's lease and the effect's own — and must stop
 * the moment either aborts. `AbortSignal.any` is not available in every
 * realm the tests run in, so the union is built by hand.
 */

export class LeaseAbortedError extends Error {
  readonly name = "AbortError";
  constructor(reason = "lease aborted") {
    super(reason);
  }
}

/** A signal that aborts when any input aborts; already aborted if one is. */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

/**
 * Run `work` unless `signal` already aborted; settle with `LeaseAbortedError`
 * as soon as it aborts, even while `work` is still pending. The wrapped
 * promise's own settlement after that point is ignored — the code was
 * disabled mid-flight and its result has no owner.
 */
export function runUnlessAborted<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new LeaseAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LeaseAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    work().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (!signal.aborted) reject(error);
      },
    );
  });
}

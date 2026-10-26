/** Own both native response branches until bounded streaming and completion settle. */
export function nativeResponseBody(
  response: Response,
  check: () => void,
  signal: AbortSignal | undefined,
  invalid: () => Error,
) {
  // Parking the mirror isolates the original reader's native EOF close. It is
  // drained only after the parser verifies actual EOF and its cumulative cap.
  // Browser tee queues can read ahead; this is not a global memory bound.
  const mirror = response.clone();
  const source = response.body;
  if (!source) throw invalid();
  const reader = source.getReader();
  let ended = false;
  let completed = false;
  let released = false;
  let cancellation: Promise<void> | undefined;
  let signalAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    signalAbort = resolve;
  });
  const current = () => {
    check();
    signal?.throwIfAborted();
  };
  function cancelBoth(): Promise<void> {
    cancellation ??= Promise.allSettled([
      // Initiate both before awaiting either: a tee cancellation waits for its
      // sibling. A reader already at EOF needs no explicit cancellation.
      Promise.resolve().then(() => (ended ? undefined : reader.cancel())),
      Promise.resolve().then(() => mirror.body?.cancel()),
    ]).then(() => undefined);
    return cancellation;
  }
  const abort = () => {
    signalAbort();
    void cancelBoth();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  function release() {
    if (!released) {
      reader.releaseLock();
      released = true;
    }
  }
  return {
    async read() {
      current();
      const next = await reader.read();
      ended = next.done;
      current();
      return next;
    },
    async finish(bytes: number) {
      if (
        !ended ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > 4 * 1024 * 1024
      )
        throw invalid();
      current();
      release();
      // Native drain is allowed only after the original bounded parser and
      // physical EOF succeed; never a parallel unbounded arrayBuffer read.
      const drained = await Promise.race([
        mirror.arrayBuffer(),
        aborted.then(() => {
          current();
          throw invalid();
        }),
      ]);
      current();
      if (drained.byteLength !== bytes) throw invalid();
      completed = true;
    },
    async close() {
      signal?.removeEventListener("abort", abort);
      try {
        if (!completed) await cancelBoth();
      } finally {
        release();
      }
    },
  };
}

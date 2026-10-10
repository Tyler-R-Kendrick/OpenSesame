/** Cancellation-only lifetime. Neither membership nor settlement grants a REAL capability. */
function unavailable(): never {
  throw new Error("Start sign-in with a current credential again.");
}
export class OriginalPrimarySubmissionLifetime {
  readonly #signal: AbortSignal | undefined;
  readonly #controller = new AbortController();
  /** Cancellation only; the original private issuer still owns admission. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  readonly #tasks = new Set<Promise<void>>();
  #canceled = false;
  #committed = false;
  #cleanup: (() => void) | undefined;
  #drain: Promise<void> | undefined;
  constructor(signal: AbortSignal | undefined) {
    this.#signal = signal;
    signal?.addEventListener("abort", this.#abort, { once: true });
    Object.freeze(this);
  }
  #abort = () => {
    void this.cancel().catch(() => {});
  };
  check = () => {
    if (!this.#committed && (this.#canceled || this.#signal?.aborted))
      unavailable();
  };
  ownCleanup = (cleanup: () => void) => {
    this.check();
    if (this.#cleanup || this.#committed) unavailable();
    this.#cleanup = cleanup;
  };
  track = <T>(work: () => Promise<T>): Promise<T> => {
    let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
    let reject: ((error: unknown) => void) | undefined;
    const task = new Promise<T>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    if (!resolve || !reject) unavailable();
    const settled = task.then(
      () => {},
      () => {},
    );
    this.#tasks.add(settled);
    void settled.then(() => this.#tasks.delete(settled));
    try {
      this.check();
      if (this.#committed) unavailable();
      // Registration precedes synchronous original capture; no provider/scope recapture hop.
      work().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return task;
  };
  commit = () => {
    this.check();
    if (this.#committed) unavailable();
    this.#committed = true;
    this.#cleanup = undefined;
    this.#signal?.removeEventListener("abort", this.#abort);
  };
  cancel = (): Promise<void> => {
    if (this.#committed) return Promise.resolve();
    if (this.#drain) return this.#drain;
    this.#canceled = true;
    this.#signal?.removeEventListener("abort", this.#abort);
    this.#drain = (async () => {
      await Promise.allSettled([...this.#tasks]);
      const cleanup = this.#cleanup;
      this.#cleanup = undefined;
      cleanup?.();
    })();
    // Cache the original drain before a platform abort listener can reenter cancellation.
    this.#controller.abort();
    return this.#drain;
  };
}

/** Exact accepted task membership supplies cancellation/drain only, never an authentication fact. */
export class OriginalPrimarySubmissionEntries<T> {
  readonly #members = new WeakMap<
    Promise<T>,
    OriginalPrimarySubmissionLifetime
  >();
  run(
    signal: AbortSignal | undefined,
    work: (lifetime: OriginalPrimarySubmissionLifetime) => Promise<T>,
  ): Promise<T> {
    const lifetime = new OriginalPrimarySubmissionLifetime(signal);
    const accepted = lifetime.track(() => work(lifetime));
    this.#members.set(accepted, lifetime);
    void accepted.catch(() => lifetime.cancel()).catch(() => {});
    return accepted;
  }
  cancel = (accepted: Promise<T>): Promise<void> => {
    const lifetime = this.#members.get(accepted);
    if (!lifetime) unavailable();
    return lifetime.cancel();
  };
}

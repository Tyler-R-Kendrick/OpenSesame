/** Pending-work DATA only; exact identities restrict deduplication and never supply authorization. */
export type OriginalIdentityGenerationData = Readonly<{
  scope: object;
  signal: AbortSignal;
  key: CryptoKey;
  policy: string;
  transport: readonly unknown[];
}>;
type Pending<T> = Readonly<{
  original: OriginalIdentityGenerationData;
  completion: Promise<T>;
}>;
function same(
  a: OriginalIdentityGenerationData,
  b: OriginalIdentityGenerationData,
) {
  return (
    a.scope === b.scope &&
    a.signal === b.signal &&
    a.key === b.key &&
    a.policy === b.policy &&
    a.transport.length === b.transport.length &&
    a.transport.every((identity, index) => identity === b.transport[index])
  );
}

/** One private Store's original identity requests; no tomb-global or borrowed-owner registry. */
export class OriginalDeviceIdentityPendingData<T> {
  readonly #pending = new Set<Pending<T>>();
  constructor() {
    Object.defineProperty(this, "run", {
      value: originalPendingRun.bind(this),
    });
    Object.freeze(this);
  }
  run(
    input: OriginalIdentityGenerationData,
    check: () => void,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      check();
    } catch (error) {
      return Promise.reject(error);
    }
    const original = Object.freeze({
      ...input,
      transport: [...input.transport],
    });
    for (const held of this.#pending) {
      if (same(held.original, original)) return held.completion;
    }
    if (this.#pending.size >= 4)
      return Promise.reject(
        new Error(
          "Original identity work must drain before another generation starts.",
        ),
      );
    const completion: Promise<T> = Promise.resolve()
      .then(async () => {
        check();
        const value = await work();
        check();
        return value;
      })
      .finally(() => {
        this.#pending.delete(held);
      });
    const held: Pending<T> = Object.freeze({ original, completion });
    this.#pending.add(held);
    return completion;
  }
}
// Capture before any actual Store can be constructed or its prototype replaced.
const originalPendingRun = OriginalDeviceIdentityPendingData.prototype.run;

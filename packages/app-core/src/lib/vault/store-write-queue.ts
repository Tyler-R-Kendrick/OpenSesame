/** Ordinary promise ordering only; never receives a key, owner verdict or admission port. */
export class StoreWriteQueue {
  #pending: Promise<void> = Promise.resolve();
  constructor() {
    Object.freeze(this);
  }
  pending = (): Promise<void> => this.#pending;
  assign = (pending: Promise<void>): void => {
    this.#pending = pending;
  };
  enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = this.#pending.then(work);
    this.#pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** Test transport signals observe actual work, never substitute its verdict. */
export function completionSignal() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

export class CompletionGroup {
  readonly pending = new Set<Promise<unknown>>();
  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    const done = () => this.pending.delete(work);
    void work.then(done, done);
    return work;
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

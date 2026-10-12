/** Own the original work and cleanup failures in their observed order. No authority is issued. */
export class OriginalAcceptedWorkFailures {
  readonly #causes: unknown[] = [];
  constructor(readonly message: string) {}

  record(cause: unknown): void {
    this.#causes.push(cause);
  }

  get failed(): boolean {
    return this.#causes.length > 0;
  }

  throwAggregateIfAny(): void {
    if (this.#causes.length)
      throw new AggregateError(this.#causes, this.message);
  }

  throwIfAny(): void {
    if (this.#causes.length === 1) throw this.#causes[0];
    if (this.#causes.length)
      throw new AggregateError(this.#causes, this.message);
  }
}

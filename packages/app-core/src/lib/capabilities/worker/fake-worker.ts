/** A worker the fake registration holds (`test-harness.ts`); `set` is the browser moving it on. */
export class FakeWorker {
  private readonly listeners = new Set<() => void>();
  constructor(
    readonly scriptURL: string,
    public state: ServiceWorkerState = "installing",
  ) {}
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.listeners.delete(listener);
  }
  set(state: ServiceWorkerState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

/** What a replacement script does once registered. */
export type InstallOutcome = "activate" | "redundant" | "hang";

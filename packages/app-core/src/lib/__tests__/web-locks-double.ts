/** FIFO test Web Locks with native callback overloads and compatible shared grants. */
type Callback<T> = (lock: Lock | null) => T | PromiseLike<T>;
export type WebLocksDouble = {
  request<T>(name: string, run: Callback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, run: Callback<T>): Promise<T>;
  readonly requested: string[];
  readonly peak: () => number;
};
type Pending = {
  mode: LockMode;
  run: () => Promise<() => void>;
  withdrawn: () => boolean;
};
type Queue = { active: number; mode: LockMode; pending: Pending[] };
function pump(queue: Queue, observe: (count: number) => void): void {
  while (queue.pending.length) {
    const next = queue.pending[0];
    if (!next) return;
    if (next.withdrawn()) {
      queue.pending.shift();
      continue;
    }
    if (
      queue.active &&
      (queue.mode === "exclusive" || next.mode === "exclusive")
    )
      return;
    queue.pending.shift();
    queue.mode = next.mode;
    queue.active++;
    observe(queue.active);
    void next.run().then((complete) => {
      queue.active--;
      pump(queue, observe);
      complete();
    });
    if (next.mode === "exclusive") return;
  }
}
function enqueue<T>(
  queue: Queue,
  name: string,
  options: LockOptions,
  run: Callback<T>,
  observe: (count: number) => void,
): Promise<T> {
  const mode = options.mode ?? "exclusive";
  options.signal?.throwIfAborted();
  if (options.steal) throw new Error("Test lock stealing is not supported.");
  const blocked =
    queue.pending.length > 0 ||
    (queue.active > 0 && (queue.mode === "exclusive" || mode === "exclusive"));
  if (options.ifAvailable && blocked) return Promise.resolve(run(null));
  return new Promise<T>((resolve, reject) => {
    let withdrawn = false;
    const abort = () => {
      withdrawn = true;
      reject(
        options.signal?.reason ??
          new DOMException("Lock request aborted.", "AbortError"),
      );
      pump(queue, observe);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    queue.pending.push({
      mode,
      withdrawn: () => withdrawn,
      run: async () => {
        options.signal?.removeEventListener("abort", abort);
        try {
          const value = await run(Object.freeze({ name, mode }));
          return () => resolve(value);
        } catch (error) {
          return () => reject(error);
        }
      },
    });
    pump(queue, observe);
  });
}
export function webLocksDouble(): WebLocksDouble {
  const queues = new Map<string, Queue>();
  const requested: string[] = [];
  let peak = 0;
  const observe = (count: number) => {
    peak = Math.max(peak, count);
  };
  return {
    requested,
    peak: () => peak,
    request<T>(
      name: string,
      ...args: [Callback<T>] | [LockOptions, Callback<T>]
    ): Promise<T> {
      requested.push(name);
      const options = args.length === 1 ? {} : args[0];
      const run = args.length === 1 ? args[0] : args[1];
      if (!run) throw new Error("Missing Web Locks callback.");
      let queue = queues.get(name);
      if (!queue) {
        queue = { active: 0, mode: "exclusive", pending: [] };
        queues.set(name, queue);
      }
      return enqueue(queue, name, options, run, observe);
    },
  };
}

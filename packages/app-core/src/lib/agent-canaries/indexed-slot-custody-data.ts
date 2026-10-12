/** Accepted indexed DATA calls only; no authentication, Root, resource capture or writer privilege. */
import type { IndexedCanarySlotData } from "./indexed-record-data.js";
export function captureIndexedCanarySlotCustodyData(
  source: IndexedCanarySlotData,
) {
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  let accepting = true;
  let count = 0;
  let closing: Promise<void> | undefined;
  function accept<T>(work: () => Promise<T>): Promise<T> {
    if (!accepting || ++count > 512)
      throw new Error("Original indexed call ended.");
    // Reserve before any effectful original guard/native method can run or reenter.
    const task = Promise.resolve().then(work);
    pending.add(task);
    void task.then(
      () => {
        pending.delete(task);
      },
      (error) => {
        pending.delete(task);
        failures.push(error);
      },
    );
    return task;
  }
  const slot = Object.freeze({
    read: () => accept(() => source.read()),
    publish: (expected: string | null, next: string) =>
      accept(() => source.publish(expected, next)),
  });
  function drain(): Promise<void> {
    if (closing) return closing;
    accepting = false;
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...pending]);
      if (failures.length)
        throw new AggregateError(
          failures,
          "Original indexed accepted calls failed.",
        );
    });
    void closing.catch(() => {});
    return closing;
  }
  return Object.freeze({ slot, drain });
}

/** Actual optional RAM lock delivery only; no absent production lease is fabricated. */
import type { LockManagerLike } from "../../ports.js";
import { checkRetiredOperationGrant } from "./captured-retired-operation-ports.js";

function originalMemoryWriterResult<T>(
  failures: unknown[],
  original: () => void,
  accepted: { value: T } | undefined,
): T {
  // A failed original operation remains failed after its accepted work drains.
  // A later stale-context check must not replace that original refusal.
  if (!failures.length) {
    try {
      original();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    const primary = failures[0];
    throw new AggregateError(
      failures,
      primary instanceof Error
        ? primary.message
        : "Original memory writer refused after drain.",
      { cause: primary },
    );
  }
  if (!accepted) throw new Error("Original memory writer delivery absent.");
  return accepted.value;
}

export async function runOriginalVolatileWriterRequestData<T>(
  locks: LockManagerLike | undefined,
  request: LockManagerLike["request"] | undefined,
  name: string,
  original: () => void,
  work: (check: () => void) => Promise<T>,
): Promise<T> {
  let live = true;
  let entered = false;
  let completed = false;
  let pending: Promise<T> | undefined;
  let accepted: { value: T } | undefined;
  const failures: unknown[] = [];
  const check = () => {
    original();
    if (!live) throw new Error("Original memory writer delivery retired.");
  };
  const accept = () => {
    check();
    if (entered) throw new Error("Original memory writer callback repeated.");
    entered = true;
    pending = (async () => {
      try {
        const value = await work(check);
        check();
        return value;
      } finally {
        completed = true;
      }
    })();
    return pending;
  };
  try {
    check();
    if (locks && request)
      await request.call(locks, name, { mode: "exclusive" }, (grant) => {
        check();
        checkRetiredOperationGrant(grant, name);
        return accept();
      });
    else if (!locks && !request) await accept();
    else throw new Error("Original memory writer locking changed.");
    check();
    if (!pending || !completed)
      throw new Error("Original memory request completed without its work.");
  } catch (error) {
    failures.push(error);
  } finally {
    live = false;
    if (pending) {
      const [result] = await Promise.allSettled([pending]);
      if (result?.status === "fulfilled") accepted = { value: result.value };
      else if (
        result?.status === "rejected" &&
        !failures.includes(result.reason)
      )
        failures.push(result.reason);
    }
  }
  return originalMemoryWriterResult(failures, original, accepted);
}

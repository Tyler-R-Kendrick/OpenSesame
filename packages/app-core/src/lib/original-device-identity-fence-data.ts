/** Identity serialization only. The private Store must supply its actual enclosing CRED/BODY callback. */
import {
  captureRetiredOperationLockData,
  checkRetiredOperationGrant,
} from "./vault/captured-retired-operation-ports.js";

function refuseOriginalIdentityFailures<T>(failures: readonly T[]) {
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    const cause = failures[0];
    throw new AggregateError(
      failures,
      cause instanceof Error
        ? cause.message
        : "Original identity refused after accepted work drain.",
      { cause },
    );
  }
}

/** Capture before queueing; a DATA callback supplies cancellation, never a production grant. */
export function captureOriginalDeviceIdentityFenceData(
  tomb: string,
  original: () => void,
) {
  if (!tomb || tomb.length > 256)
    throw new Error("Original identity scope unavailable.");
  const ports = captureRetiredOperationLockData(original);
  const name = `opensesame-device-identity-${tomb}`;
  const run = async <T>(work: (check: () => void) => Promise<T>) => {
    ports.check();
    let live = true;
    let entered = false;
    let completed = false;
    let pending: Promise<T> | undefined;
    let accepted: { value: T } | undefined;
    const failures: unknown[] = [];
    const check = () => {
      ports.check();
      if (!live) throw new Error("Original identity delivery retired.");
    };
    try {
      await ports.request.call(
        ports.locks,
        name,
        { mode: "exclusive" },
        (grant) => {
          check();
          if (entered) throw new Error("Original identity callback repeated.");
          entered = true;
          checkRetiredOperationGrant(grant, name);
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
        },
      );
      check();
      if (!pending || !completed)
        throw new Error(
          "Original identity request completed without its callback.",
        );
    } catch (error) {
      failures.push(error);
    } finally {
      // Early return/rejection retires further delivery and drains already accepted work.
      live = false;
      if (pending) {
        const [outcome] = await Promise.allSettled([pending]);
        if (outcome?.status === "fulfilled")
          accepted = { value: outcome.value };
        else if (
          outcome?.status === "rejected" &&
          !failures.includes(outcome.reason)
        )
          failures.push(outcome.reason);
      }
    }
    if (!failures.length) {
      try {
        ports.check();
      } catch (cause) {
        failures.push(cause);
      }
    }
    refuseOriginalIdentityFailures(failures);
    if (!accepted) throw new Error("Original identity delivery absent.");
    return accepted.value;
  };
  return Object.freeze({ check: ports.check, run });
}

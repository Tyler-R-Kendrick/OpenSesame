/** Settled command diagnostics only; these receipts cannot authenticate or issue a principal. */
export type OriginalCommandRetirementReport = Readonly<{
  observedWorkFailures: readonly unknown[];
  drainFailures: readonly unknown[];
}>;
export type OriginalCommandDrainRecorder = <T>(cause: T) => void;
export function refuseOriginalCommandOutcomes<T>(failures: readonly T[]) {
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Original command work and disposal failed.",
      { cause: failures[0] },
    );
}
export async function disposeOriginalCommandData(
  failure: ErrorOptions | undefined,
  record: OriginalCommandDrainRecorder | undefined,
  actions: readonly (() => Promise<void> | undefined)[],
) {
  const failures: unknown[] = failure ? [failure.cause] : [];
  for (const action of actions) {
    try {
      await action();
    } catch (cause) {
      failures.push(cause);
      try {
        record?.(cause);
      } catch (reported) {
        failures.push(reported);
      }
    }
  }
  refuseOriginalCommandOutcomes(failures);
}
export async function captureOriginalCommandResourceData<T>(
  record: OriginalCommandDrainRecorder | undefined,
  capture: () => Promise<T>,
): Promise<T> {
  try {
    return await capture();
  } catch (cause) {
    // Failed delivery supplies no independently verified disposal receipt.
    const failures = [cause];
    try {
      record?.(cause);
    } catch (reported) {
      failures.push(reported);
    }
    refuseOriginalCommandOutcomes(failures);
    throw cause;
  }
}
export async function observeOriginalCommandLeaseData<T>(
  record: OriginalCommandDrainRecorder,
  enter: (work: () => Promise<T>) => Promise<T>,
  work: () => Promise<T>,
): Promise<T> {
  let failure: ErrorOptions | undefined;
  const accepted = async () => {
    try {
      return await work();
    } catch (cause) {
      failure = { cause };
      throw cause;
    }
  };
  try {
    return await enter(accepted);
  } catch (cause) {
    // The actual request must forward its callback's exact cause when its own release succeeds.
    if (!failure || !Object.is(cause, failure.cause)) {
      try {
        record(cause);
      } catch (reported) {
        refuseOriginalCommandOutcomes([cause, reported]);
      }
    }
    throw cause;
  }
}

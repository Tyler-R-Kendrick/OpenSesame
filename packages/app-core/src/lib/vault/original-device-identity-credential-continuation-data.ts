/** Fixed actual CRED callback delivery/drain only; lexical callbacks never issue a Root/factor/owner grant. */
import { CREDENTIAL_LOCK_NAME } from "../retired-credentials/credential-lock.js";
import { captureRetiredOperationLockData } from "./captured-retired-operation-ports.js";
import { runOriginalVolatileWriterRequestData } from "./original-volatile-writer-request-data.js";

export type OriginalIdentityCredentialContinuationData = <T>(
  work: (credential: () => void) => Promise<T>,
) => Promise<T>;

/** Construct only inside a fixed producer's actual accepted CRED callback; `credential` cancels, never grants a lease. */
export async function withOriginalIdentityCredentialContinuationData<T>(
  credential: () => void,
  work: (
    continuation: OriginalIdentityCredentialContinuationData,
  ) => Promise<T>,
): Promise<T> {
  credential();
  let live = true;
  let entered = false;
  let accepted: Promise<unknown> | undefined;
  const check = () => {
    credential();
    if (!live) throw new Error("Original credential continuation retired.");
  };
  const run: OriginalIdentityCredentialContinuationData = <U>(
    child: (original: () => void) => Promise<U>,
  ): Promise<U> => {
    try {
      check();
      if (entered)
        throw new Error("Original credential continuation repeated.");
      entered = true;
    } catch (error) {
      return Promise.reject(error);
    }
    let completed = false;
    const pending = Promise.resolve().then(async () => {
      try {
        check();
        const value = await child(check);
        check();
        return value;
      } finally {
        completed = true;
      }
    });
    accepted = pending;
    // A caller cannot return from its actual CRED producer while accepted BODY/identity work remains unawaited.
    void pending.then(
      () => {},
      () => {},
    );
    completion = () => completed;
    return pending;
  };
  let completion = () => true;
  let result: { value: T } | undefined;
  const failures: unknown[] = [];
  try {
    const value = await work(run);
    check();
    if (!completion())
      throw new Error("Original credential child work was not awaited.");
    result = { value };
  } catch (error) {
    failures.push(error);
  } finally {
    live = false;
    if (accepted) {
      const [outcome] = await Promise.allSettled([accepted]);
      if (outcome?.status === "rejected" && !failures.includes(outcome.reason))
        failures.push(outcome.reason);
    }
  }
  try {
    credential();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Original credential continuation refused after accepted work drain.",
    );
  if (!result)
    throw new Error("Original credential continuation result absent.");
  return result.value;
}

/** Legacy/no-entry producer requests its own actual original CRED; missing production transport is a refusal. */
export function runOriginalIdentityCredentialContinuationData<T>(
  original: () => void,
  work: (
    continuation: OriginalIdentityCredentialContinuationData,
  ) => Promise<T>,
): Promise<T> {
  try {
    const ports = captureRetiredOperationLockData(original);
    return runOriginalVolatileWriterRequestData(
      ports.locks,
      ports.request,
      CREDENTIAL_LOCK_NAME,
      ports.check,
      (credential) =>
        withOriginalIdentityCredentialContinuationData(credential, work),
    );
  } catch (error) {
    return Promise.reject(error);
  }
}

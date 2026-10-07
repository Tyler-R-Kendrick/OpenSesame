const pending = new Set<Promise<void>>();

/** Drain best-effort evidence before a short-lived human client exits. */
export async function flushRetiredCredentialTelemetry(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

export function trackRetiredCredentialTelemetry(
  work: Promise<void>,
): Promise<void> {
  pending.add(work);
  void work.then(
    () => pending.delete(work),
    () => pending.delete(work),
  );
  return work;
}

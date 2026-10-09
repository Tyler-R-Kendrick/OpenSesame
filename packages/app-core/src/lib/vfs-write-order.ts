/** Per-tomb promise ordering only; receives no key, owner or admission. */
/**
 * Sealed writes are read-modify-write against the tomb index, so they run
 * one at a time per tomb — a body persist and a prefs write can never lose
 * each other's index entries.
 */
const tombWriteChains = new Map<string, Promise<unknown>>();

export function enqueueTombWrite<T>(
  tomb: string,
  op: () => Promise<T>,
): Promise<T> {
  const run = (tombWriteChains.get(tomb) ?? Promise.resolve()).then(op);
  tombWriteChains.set(
    tomb,
    run.catch(() => undefined),
  );
  return run;
}

/** Settle every queued tomb write — for tests that need a quiet store. */
export async function vfsFlush(): Promise<void> {
  await Promise.all([...tombWriteChains.values()]);
}

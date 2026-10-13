/** Cleanup/cancellation DATA only; accepts no Root, credential or principal grant. */
export type PrivatePresentationCloseData = Readonly<{
  close: () => Promise<void>;
}>;
export function closePrivatePresentationData(
  data: PrivatePresentationCloseData | undefined,
  retiring: Set<Promise<void>>,
): Promise<void> {
  if (!data) return Promise.resolve();
  let accepted: () => void = () => {};
  let refused: (cause: unknown) => void = () => {};
  const drained = new Promise<void>((resolve, reject) => {
    accepted = resolve;
    refused = reject;
  });
  retiring.add(drained);
  void drained.then(
    () => retiring.delete(drained),
    () => retiring.delete(drained),
  );
  try {
    void data.close().then(accepted, refused);
  } catch (error) {
    refused(error);
  }
  return drained;
}
export async function drainPrivatePresentationData(
  tasks: readonly Promise<void>[],
): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Original presentation cleanup failed.");
}

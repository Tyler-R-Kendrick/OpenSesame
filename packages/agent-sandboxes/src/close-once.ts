/** Share an in-flight close and retain success; failed closes remain retryable. */
export function closeOnce(close: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) {
      pending = close().catch((error) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}

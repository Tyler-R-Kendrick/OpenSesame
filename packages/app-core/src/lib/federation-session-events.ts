/** Same-tab presentation invalidation only; readers must revalidate the original session. */
const listeners = new Set<() => void>();
let queued = false;

export function subscribeFederationSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** No identity, token, generation receipt or authority is carried to observers. */
export function notifyFederationSessionChanged(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) listener();
    }
  });
}

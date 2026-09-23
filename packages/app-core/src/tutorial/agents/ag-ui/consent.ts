import type { RemoteSupportPayload } from "@opensesame/support-agent";

export type RemotePreview = {
  readonly id: number;
  readonly destination: string;
  readonly payload: RemoteSupportPayload;
};
let current: RemotePreview | null = null;
let settle: ((allowed: boolean) => void) | null = null;
let sequence = 0;
const listeners = new Set<() => void>();
export const remotePreviewSnapshot = () => current;
export function subscribeRemotePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish(): void {
  for (const listener of listeners) listener();
}
export function decideRemotePreview(id: number, allowed: boolean): void {
  if (current?.id === id) settle?.(allowed);
}

/** One request, one exact immutable preview, one decision; cancellation never sends. */
export function requestRemoteConsent(
  destination: string,
  payload: RemoteSupportPayload,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || current) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = ++sequence;
    const abort = () => finish(false);
    const timer = setTimeout(abort, 60_000);
    const finish = (allowed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (current?.id === id) {
        current = null;
        settle = null;
        publish();
      }
      resolve(allowed);
    };
    settle = finish;
    current = Object.freeze({ id, destination, payload });
    signal.addEventListener("abort", abort, { once: true });
    publish();
  });
}

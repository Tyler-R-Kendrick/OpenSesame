import { SupportError } from "@opensesame/support-agent";
export function isOnlineDefault(): boolean {
  return globalThis.navigator?.onLine !== false;
}
export function abortPromise(signal: AbortSignal): Promise<null> {
  return new Promise((settle) => {
    if (signal.aborted) {
      settle(null);
      return;
    }
    signal.addEventListener("abort", () => settle(null), { once: true });
  });
}

export function aborted(): SupportError {
  return new SupportError("AGENT_ABORTED", "the support request was cancelled");
}

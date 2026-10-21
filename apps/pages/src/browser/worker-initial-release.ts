import type { RegisterWorkerOptions } from "@opensesame/app-core/lib/capabilities/worker/types.js";
/** First-install entry compatibility, not a measurement of the navigation HTML. */
import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";

function entryScope(pageModuleUrl: string, scopeUrl: string): URL | null {
  let entry: URL;
  let scope: URL;
  try {
    entry = new URL(pageModuleUrl);
    scope = new URL(scopeUrl);
  } catch {
    return null;
  }
  if (
    entry.href !== pageModuleUrl ||
    scope.href !== scopeUrl ||
    entry.origin !== location.origin ||
    scope.origin !== entry.origin ||
    !scope.pathname.endsWith("/") ||
    !entry.href.startsWith(scope.href) ||
    entry.search ||
    entry.hash ||
    scope.search ||
    scope.hash ||
    !/^assets\/main-[A-Za-z0-9_-]{8,64}\.js$/.test(
      entry.href.slice(scope.href.length),
    )
  )
    return null;
  return scope;
}

/** Called by the actual main entry before registration; never supplied by configuration. */
export function createInitialWorkerReleaseProof(
  pageModuleUrl: string,
  scopeUrl: string,
): RegisterWorkerOptions["initialReleaseProof"] | null {
  if (
    !isSecureContext ||
    !crossOriginIsolated ||
    navigator.serviceWorker?.controller
  )
    return null;
  const scope = entryScope(pageModuleUrl, scopeUrl);
  if (!scope) return null;
  return (worker, signal) => {
    const script = new URL(worker.scriptURL);
    const variant =
      script.pathname === `${scope.pathname}sw.js`
        ? "core-only"
        : script.pathname === `${scope.pathname}sw-push.js`
          ? "push"
          : null;
    if (signal.aborted || script.origin !== scope.origin || !variant)
      return Promise.resolve(null);
    const nonce = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const channel = new MessageChannel();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (release: string | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        channel.port1.onmessage = null;
        channel.port1.onmessageerror = null;
        channel.port1.close();
        channel.port2.close();
        resolve(release);
      };
      const cancel = () => finish(null);
      signal.addEventListener("abort", cancel, { once: true });
      channel.port1.onmessageerror = cancel;
      channel.port1.onmessage = (event: MessageEvent) => {
        const data = overlapCast(event.data);
        const valid =
          event.ports.length === 0 &&
          isJsonObject(data) &&
          data.type === "WORKER_INFO" &&
          data.pageModuleUrl === pageModuleUrl &&
          data.proofNonce === nonce &&
          data.scopePath === scope.pathname &&
          data.variant === variant &&
          isString(data.releaseId) &&
          /^[A-Za-z0-9_-]{1,64}$/.test(data.releaseId);
        for (const port of event.ports) port.close();
        finish(
          valid && isJsonObject(data) && isString(data.releaseId)
            ? data.releaseId
            : null,
        );
      };
      try {
        worker.postMessage(
          { type: "WORKER_HELLO", pageModuleUrl, proofNonce: nonce },
          [channel.port2],
        );
      } catch {
        finish(null);
      }
    });
  };
}

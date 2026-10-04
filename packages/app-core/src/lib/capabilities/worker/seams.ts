/**
 * The four pieces of the platform the worker controller touches, behind
 * replaceable defaults: the `ServiceWorkerContainer`, whether this document is
 * cross-origin isolated, the base URL every worker script and scope is
 * resolved against, and the page reload a controller change triggers.
 *
 * Nothing here imports `virtual:pwa-register` or workbox-window: the
 * registration call is the platform's own.
 */

import { overlapCast } from "@opensesame/os-domain";
import { env } from "../../../host.js";

function serviceWorkerContainerDefault(): ServiceWorkerContainer | null {
  const scope: { navigator?: { serviceWorker?: ServiceWorkerContainer } } =
    overlapCast(globalThis);
  return scope.navigator?.serviceWorker ?? null;
}

function crossOriginIsolatedDefault(): boolean {
  const scope: { crossOriginIsolated?: boolean } = overlapCast(globalThis);
  return scope.crossOriginIsolated === true;
}

function baseUrlDefault(): string {
  const scope: { location?: { href: string } } = overlapCast(globalThis);
  return new URL(env().BASE_URL, scope.location?.href ?? "https://localhost/")
    .href;
}

function reloadDefault(): void {
  const scope: { location?: { reload: () => void } } = overlapCast(globalThis);
  scope.location?.reload();
}

/** Run `run` after `ms`; the returned function cancels it. */
function laterDefault(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

export const workerControllerSeams = {
  later: laterDefault,
  serviceWorkerContainer: serviceWorkerContainerDefault,
  crossOriginIsolated: crossOriginIsolatedDefault,
  baseUrl: baseUrlDefault,
  reload: reloadDefault,
};

/** A variant's script path as an absolute URL under this deployment's base. */
export function scriptUrlFor(scriptPath: string): string {
  return new URL(scriptPath, workerControllerSeams.baseUrl()).href;
}

/**
 * Whether two script URLs are the same script: origin and path, never the
 * query. A replacement the controller had to ask for again carries a counter
 * in its query (`?r=1`); it is still the variant's script.
 */
export function sameScript(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
}

/** `scriptUrl` as attempt number `attempt` of asking for it: a fresh script URL. */
export function scriptUrlAttempt(scriptUrl: string, attempt: number): string {
  const url = new URL(scriptUrl);
  if (attempt > 0) url.searchParams.set("r", String(attempt));
  return url.href;
}

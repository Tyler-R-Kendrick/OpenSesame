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
  return new URL(
    import.meta.env.BASE_URL,
    scope.location?.href ?? "https://localhost/",
  ).href;
}

function reloadDefault(): void {
  const scope: { location?: { reload: () => void } } = overlapCast(globalThis);
  scope.location?.reload();
}

export const workerControllerSeams = {
  serviceWorkerContainer: serviceWorkerContainerDefault,
  crossOriginIsolated: crossOriginIsolatedDefault,
  baseUrl: baseUrlDefault,
  reload: reloadDefault,
};

/** A variant's script path as an absolute URL under this deployment's base. */
export function scriptUrlFor(scriptPath: string): string {
  return new URL(scriptPath, workerControllerSeams.baseUrl()).href;
}

/**
 * Check for a newer app shell and start downloading it.
 *
 * An installed PWA otherwise only rechecks the service worker on a cold
 * navigation (or on the browser's own interval). Unlock is the moment a
 * person is waiting with the vault sealed — start the fetch then so a
 * newer shell is installing before they open it. `registerType: autoUpdate`
 * plus `skipWaiting` in `sw.ts` take care of activating once the download
 * finishes; `main.tsx` reloads on `controllerchange`.
 */

import { overlapCast } from "@opensesame/os-domain";

function serviceWorkerContainerDefault(): ServiceWorkerContainer | null {
  const scope: { navigator?: { serviceWorker?: ServiceWorkerContainer } } =
    overlapCast(globalThis);
  return scope.navigator?.serviceWorker ?? null;
}

export const pwaUpdateSeams = {
  serviceWorkerContainer: serviceWorkerContainerDefault,
};

/**
 * Probe the registered service worker for an update. A changed worker
 * script begins installing (and downloading its precache). Resolves
 * `true` when a registration was asked to update, `false` when there is
 * no worker or the check could not run (offline, unsupported).
 */
export async function checkForAppUpdate(): Promise<boolean> {
  const container = pwaUpdateSeams.serviceWorkerContainer();
  if (!container) return false;
  try {
    const registration = await container.getRegistration();
    if (!registration) return false;
    await registration.update();
    return true;
  } catch {
    return false;
  }
}

/**
 * Waiting for a registered script to actually take the scope.
 *
 * `register()` resolves when the registration exists, not when the worker is
 * running: the script still has to download, install and activate, and any of
 * those can fail (a 404, a syntax error, an install that throws), leaving the
 * worker `redundant` and the old one in charge. The controller reports a
 * variant as running, and does what depends on it (dropping the subscription
 * the old worker held), only once this says the new one is.
 */

import { workerControllerSeams } from "./seams.js";
import { ACTIVATION_WAIT_MS } from "./types.js";

function workerAt(
  registration: ServiceWorkerRegistration,
  scriptUrl: string,
): ServiceWorker | null {
  for (const worker of [
    registration.installing,
    registration.waiting,
    registration.active,
  ]) {
    if (worker?.scriptURL === scriptUrl) return worker;
  }
  return null;
}

/**
 * Whether the worker at `scriptUrl` activates: `true` once it is activated,
 * `false` when it turns redundant, was never there, or does not settle within
 * the bound.
 */
export function becomesActive(
  registration: ServiceWorkerRegistration,
  scriptUrl: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const worker = workerAt(registration, scriptUrl);
    if (!worker) return resolve(false);
    let cancel = () => {};
    const finish = (activated: boolean) => {
      cancel();
      worker.removeEventListener("statechange", check);
      resolve(activated);
    };
    const check = () => {
      if (worker.state === "activated") finish(true);
      else if (worker.state === "redundant") finish(false);
    };
    worker.addEventListener("statechange", check);
    cancel = workerControllerSeams.later(
      () => finish(false),
      ACTIVATION_WAIT_MS,
    );
    check();
  });
}

/** The variant-bearing script URL of the worker that is active, or null. */
export function activeScript(
  registration: ServiceWorkerRegistration | undefined,
): string | null {
  return registration?.active?.scriptURL ?? null;
}

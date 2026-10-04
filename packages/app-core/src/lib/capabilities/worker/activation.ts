/**
 * Waiting for a registered script to actually take the scope.
 *
 * `register()` resolves when the registration exists, not when the worker is
 * running: the script still has to download, install and activate, and any of
 * those can fail (a 404, a syntax error, an install that throws), leaving the
 * worker `redundant` and the old one in charge. The controller reports a
 * variant as running, and does what depends on it (dropping the subscription
 * the old worker held), only once this says the new one is.
 *
 * Activation can also wedge. A replacement that has installed and called
 * `skipWaiting()` is activated by the browser after it stops the old worker;
 * if a fetch from another tab this worker controls restarts the old worker in
 * that instant, Chrome never completes the activation and the replacement
 * stays `installed` for as long as that tab lives — not for want of
 * `skipWaiting` (it is called at the top of the script and again in install
 * with no difference), and not cured by waiting, by a repeated `skipWaiting`,
 * by `update()`, or by registering the same URL again. It reproduces in a
 * bare page with two workers about one run in ten. What does cure it is a
 * *new version*: asking for the script again under a fresh URL (`?r=1`)
 * replaces the waiting one and runs the activation again, which succeeds
 * almost every time and, repeated, always. So a worker still waiting after
 * `WAITING_NUDGE_MS` is asked for again, and again, until the bound. A request
 * that never answers is raced against the same bound, so it cannot hold the
 * caller; what is left waiting at the bound is picked up again by
 * `worker/recover.ts`.
 */

import { sameScript, workerControllerSeams } from "./seams.js";
import { ACTIVATION_WAIT_MS, WAITING_NUDGE_MS } from "./types.js";

function workerAt(
  registration: ServiceWorkerRegistration,
  scriptUrl: string,
): ServiceWorker | null {
  for (const worker of [
    registration.installing,
    registration.waiting,
    registration.active,
  ]) {
    if (worker && sameScript(worker.scriptURL, scriptUrl)) return worker;
  }
  return null;
}

type Outcome = "activated" | "redundant" | "elapsed";

/** One worker, watched until it settles or `ms` pass. */
function watch(worker: ServiceWorker, ms: number): Promise<Outcome> {
  return new Promise((resolve) => {
    let cancel = () => {};
    const finish = (outcome: Outcome) => {
      cancel();
      worker.removeEventListener("statechange", check);
      resolve(outcome);
    };
    const check = () => {
      if (worker.state === "activated") finish("activated");
      else if (worker.state === "redundant") finish("redundant");
    };
    worker.addEventListener("statechange", check);
    cancel = workerControllerSeams.later(() => finish("elapsed"), ms);
    check();
  });
}

/** Asks for the script again, as attempt number `attempt`. */
export type Reregister = (
  attempt: number,
) => Promise<ServiceWorkerRegistration | null>;

/**
 * Whether the worker at `scriptUrl` activates: `true` once it is activated,
 * `false` when it turns redundant, was never there, or does not settle within
 * the bound. A worker that sits installed is asked for again through
 * `reregister`.
 */
export async function becomesActive(
  registration: ServiceWorkerRegistration,
  scriptUrl: string,
  reregister: Reregister,
): Promise<boolean> {
  let overdue = false;
  let lapse = () => {};
  // Resolves when the bound is reached, so a `reregister` whose script fetch
  // never answers cannot hold the caller (or the reconcile chain) past it.
  const deadline = new Promise<null>((resolve) => {
    lapse = () => resolve(null);
  });
  const cancel = workerControllerSeams.later(() => {
    overdue = true;
    lapse();
  }, ACTIVATION_WAIT_MS);
  try {
    let current = registration;
    let attempt = 0;
    for (;;) {
      const worker = workerAt(current, scriptUrl);
      if (!worker) return false;
      const outcome = await watch(worker, WAITING_NUDGE_MS);
      if (outcome === "activated") return true;
      if (outcome === "redundant" || overdue) return false;
      // Only a worker that has installed and is waiting is wedged; one still
      // downloading or installing is slow, and is left alone.
      if (worker.state !== "installed") continue;
      attempt += 1;
      const again = await Promise.race([reregister(attempt), deadline]);
      if (!again) return false;
      current = again;
    }
  } finally {
    cancel();
  }
}

/** The variant-bearing script URL of the worker that is active, or null. */
export function activeScript(
  registration: ServiceWorkerRegistration | undefined,
): string | null {
  return registration?.active?.scriptURL ?? null;
}

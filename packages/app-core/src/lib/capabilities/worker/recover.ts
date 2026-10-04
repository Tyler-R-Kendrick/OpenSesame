/**
 * Asking for a worker again, and coming back to one that was given up on.
 *
 * A replacement the browser leaves waiting is asked for under a fresh script
 * URL (`worker/activation.ts`). When that gives up at the bound, the waiting
 * worker is still in the registration, and the scope must not then count as
 * settled for the life of the page: a waiting replacement of the required
 * script, while another variant is active, is a transition that did not
 * finish. The controller tries it again, a few times, further apart each time.
 */

import {
  sameScript,
  scriptUrlAttempt,
  workerControllerSeams,
} from "./seams.js";
import { state } from "./state.js";

/** How long after giving up the controller looks again, then again, then last. */
export const RECOVERY_BACKOFF_MS = [30_000, 120_000, 600_000] as const;

/** The counter in a script URL's `r` query: how many times it was asked for. */
function attemptOf(scriptUrl: string | null | undefined): number {
  if (!scriptUrl) return 0;
  try {
    const n = Number(new URL(scriptUrl).searchParams.get("r"));
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** The highest attempt any worker of the registration was asked for under. */
export function newestAttempt(
  registration: ServiceWorkerRegistration | undefined,
): number {
  const workers = [
    registration?.installing,
    registration?.waiting,
    registration?.active,
  ];
  return Math.max(state.asked, ...workers.map((w) => attemptOf(w?.scriptURL)));
}

/** The next fresh URL for `scriptUrl`: never one a worker already holds. */
export function freshScriptUrl(
  registration: ServiceWorkerRegistration | undefined,
  scriptUrl: string,
): string {
  state.asked = newestAttempt(registration) + 1;
  return scriptUrlAttempt(scriptUrl, state.asked);
}

/**
 * Whether the registration holds a replacement of the required script that
 * installed and never took the scope, with another script (or none) active.
 */
export function stuckWaiting(
  registration: ServiceWorkerRegistration | undefined,
  requiredUrl: string,
): boolean {
  const waiting = registration?.waiting;
  if (!waiting || !sameScript(waiting.scriptURL, requiredUrl)) return false;
  return !sameScript(registration?.active?.scriptURL ?? null, requiredUrl);
}

/** A recovery attempt is allowed: the page has not used them all. */
export function takeRecoveryTurn(): boolean {
  if (state.recoveries >= RECOVERY_BACKOFF_MS.length) return false;
  state.recoveries += 1;
  return true;
}

/**
 * Look again after a delay that grows with each recovery, once the controller
 * has given up. One timer at a time; none when the attempts are used up.
 */
export function scheduleRecheck(rerun: () => void): void {
  state.recheckCancel?.();
  state.recheckCancel = null;
  const wait = RECOVERY_BACKOFF_MS[state.recoveries];
  if (wait === undefined) return;
  state.recheckCancel = workerControllerSeams.later(() => {
    state.recheckCancel = null;
    rerun();
  }, wait);
}

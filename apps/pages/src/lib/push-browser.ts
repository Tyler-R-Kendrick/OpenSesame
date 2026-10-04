import { overlapCast } from "@opensesame/os-domain";
import { PushError, pushSeams } from "./push-seams.js";

/**
 * The browser's side of enrolment: which worker is ready, whether it is the
 * push one, and what a failed or stale subscription means. `push-enrolment.ts`
 * is the conversation that uses it. Document code only.
 */

const NO_WORKER =
  "This browser has no service worker here, so it cannot receive push notifications. That changes nothing about approving requests — they still wait for you in the app.";

/**
 * The registration once a worker is ready, or `null` when none becomes ready
 * in time. `ready` never rejects and never settles for a scope nothing is
 * registered on, so an unbounded wait would hang the row's key for ever.
 */
export async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  const container = pushSeams.serviceWorkerContainer();
  if (!container) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), pushSeams.readyWaitMs);
  });
  try {
    return await Promise.race([container.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether this browser holds a push subscription now. */
export async function pushSubscribed(): Promise<boolean> {
  const registration = await readyRegistration();
  if (!registration) return false;
  return (await registration.pushManager.getSubscription()) !== null;
}

/**
 * The registration whose worker can receive a push. Approving the capability
 * replaces the core worker with the push variant a moment later, and a
 * subscription taken while the core worker still holds the scope would be
 * delivered to a worker with no `push` handler, so wait for the swap.
 */
export async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  if (!pushSeams.serviceWorkerContainer()) {
    throw new PushError("unsupported", NO_WORKER);
  }
  const registration = await readyRegistration();
  if (!registration) {
    throw new PushError(
      "unavailable",
      "No service worker is running for this app yet, so push cannot be turned on. Reload the page and try again.",
    );
  }
  const stop = Date.now() + pushSeams.pushWorkerWaitMs;
  while (!pushSeams.workerIsPush(registration)) {
    if (Date.now() >= stop) {
      throw new PushError(
        "unavailable",
        "The push worker is still being installed on this device. Try again in a moment.",
      );
    }
    await pushSeams.pause(100);
  }
  return registration;
}

/** What `subscribe()` throwing says, by the DOMException name the spec gives. */
function subscribeFailure(name: string): PushError {
  if (name === "NotAllowedError") {
    return new PushError(
      "denied",
      "Notifications are blocked for this site, so nothing can be delivered here. Requests still wait for you in the app.",
    );
  }
  if (name === "AbortError" || name === "NetworkError") {
    return new PushError(
      "unavailable",
      "This browser's push service could not be reached, so push was not turned on. Try again later; requests still wait for you in the app.",
    );
  }
  if (name === "NotSupportedError" || name === "SecurityError") {
    return new PushError(
      "unsupported",
      "This browser cannot subscribe to push from here. Requests still wait for you in the app.",
    );
  }
  return new PushError(
    "failed",
    "This browser could not subscribe to push. Requests still wait for you in the app.",
  );
}

/**
 * Whether a subscription was made against this signing key. A browser that
 * does not say keeps what it has: a key that rotated is caught where it can be
 * seen.
 */
export function madeWith(
  subscription: PushSubscription,
  key: Uint8Array,
): boolean {
  const held = subscription.options?.applicationServerKey;
  if (!held) return true;
  const bytes = new Uint8Array(held);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

export async function subscribeNew(
  worker: ServiceWorkerRegistration,
  key: Uint8Array,
): Promise<PushSubscription> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(subscribeFailure("AbortError")),
      pushSeams.subscribeWaitMs,
    );
  });
  try {
    return await Promise.race([
      worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: overlapCast(key),
      }),
      timeout,
    ]);
  } catch (caught) {
    if (caught instanceof PushError) throw caught;
    throw subscribeFailure(caught instanceof Error ? caught.name : "");
  } finally {
    clearTimeout(timer);
  }
}

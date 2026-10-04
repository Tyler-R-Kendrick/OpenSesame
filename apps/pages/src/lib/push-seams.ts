import { EgressDenied } from "@opensesame/app-core/lib/capabilities/egress.js";
import { overlapCast } from "@opensesame/os-domain";

/**
 * What enrolment may not do for itself: the typed refusals it speaks in and
 * the platform seams a test replaces (`push-enrolment.ts` is the conversation,
 * `push-browser.ts` the browser's side of it). Document code only; the service
 * worker's half is `push.ts`.
 */

export type PushErrorCode =
  | "unsupported"
  | "denied"
  | "blocked"
  | "unavailable"
  | "conflict"
  | "limit"
  | "failed";

export class PushError extends Error {
  constructor(
    readonly code: PushErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PushError";
  }
}

/**
 * Enrolment has one road out, the egress port, and the capability's module
 * installs it while the capability is approved. Anywhere else — before it is
 * installed, and after the capability is removed with a request still in
 * flight — there is no road: the call is refused the way egress refuses a
 * capability that is not approved, and nothing reaches the network.
 */
export function noRoadOut(url: string): Promise<Response> {
  return Promise.reject(
    new EgressDenied(
      "capability-not-approved",
      "notifications.web-push",
      new URL(url, "https://invalid.example").origin,
    ),
  );
}

async function fetchFnDefault(
  url: string,
  _init: RequestInit,
): Promise<Response> {
  return noRoadOut(url);
}

function serviceWorkerContainerDefault(): ServiceWorkerContainer | null {
  const scope: { navigator?: { serviceWorker?: ServiceWorkerContainer } } =
    overlapCast(globalThis);
  return scope.navigator?.serviceWorker ?? null;
}

function pushApiAvailableDefault(): boolean {
  return "PushManager" in globalThis && "Notification" in globalThis;
}

async function requestPermissionDefault(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}

function pauseDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const pushSeams = {
  fetchFn: fetchFnDefault,
  serviceWorkerContainer: serviceWorkerContainerDefault,
  pushApiAvailable: pushApiAvailableDefault,
  requestPermission: requestPermissionDefault,
  /**
   * Whether the worker holding this registration is the push variant. Only
   * the document module that can name the distribution knows
   * (`modules/notifications.web-push/runtime.ts` replaces this); until then
   * every worker counts, which is what a test that is not about the swap wants.
   */
  workerIsPush: (_registration: ServiceWorkerRegistration): boolean => true,
  /** How long to wait for any worker to be ready, and then for the push one. */
  readyWaitMs: 8000,
  pushWorkerWaitMs: 10000,
  /** A call to the Identity API, and the browser's own subscribe, are bounded. */
  requestTimeoutMs: 15000,
  subscribeWaitMs: 30000,
  pause: pauseDefault,
};

/** Both halves have to be there: a worker to receive it, and an API to ask. */
export function pushSupported(): boolean {
  return (
    pushSeams.serviceWorkerContainer() !== null && pushSeams.pushApiAvailable()
  );
}

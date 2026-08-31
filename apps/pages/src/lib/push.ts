import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";

/**
 * Web Push enrolment, and the two pure functions the service worker uses to
 * render what arrives (ADR 0081).
 *
 * A push notification is the least private surface this product has. It lands
 * on a lock screen in a coffee shop, on a watch face, in a screenshot, in
 * whatever the operating system keeps in its notification history. So the
 * contract here is that a push body is *minimal*: it says that authorization
 * was requested, and it says to open the app. It does not say what was asked
 * for, who asked, which principal it belongs to, or what code to type.
 *
 * That is enforced structurally rather than by care. `pushNotificationBody`
 * reads exactly three fields off the payload — a kind, a closed action label,
 * and an opaque reference — and every one of them selects from a fixed table
 * of strings compiled into this file. A server that started sending
 * `authorizationDetails` in the payload could not get them onto a lock screen
 * through this function, because there is no path from the payload's text to
 * the notification's text.
 *
 * The reference is the same story. It is matched against a strict opaque
 * pattern before it is allowed near a URL, so a payload cannot smuggle a path,
 * an origin, a query string or a bearer into the click target. The click URL
 * is always resolved against the worker's own registration scope, which means
 * it is always same-origin, whatever the payload says.
 *
 * Because `sw.ts` imports this module, nothing here may import anything with
 * module-level browser state: a service worker has no `window`, no
 * `localStorage`, and no DOM.
 */

/* ------------------------------------------------------------------ *
 * The lock-screen contract
 * ------------------------------------------------------------------ */

export interface PushNotificationView {
  title: string;
  body: string;
  tag: string;
  /** Carried into `notificationclick`. Opaque reference only. */
  data: { ref: string };
}

/**
 * A rendezvous reference, as a shape rather than a meaning.
 *
 * No slash, colon, dot-dot, space or percent: the reference can therefore
 * never be a relative path that escapes the scope, an absolute URL, or a
 * carrier for a credential. Anything else is treated as absent.
 */
const OPAQUE_REF = /^[A-Za-z0-9_-]{1,128}$/;

const TITLES = new Map<string, string>(
  Object.entries({
    authorization_request: "Authorization requested",
    authorization_decision: "A request you sent was decided",
    security_event: "Security alert",
  }),
);

/**
 * The only bodies that can ever be shown. A closed set, not a template: the
 * payload picks one, it does not supply one.
 */
const BODIES = new Map<string, string>(
  Object.entries({
    review: "Open OpenSesame to review it.",
    decided: "Open OpenSesame to see it.",
    none: "Open OpenSesame.",
  }),
);

const DEFAULT_TITLE = "Authorization requested";
const DEFAULT_BODY = "Open OpenSesame.";

function opaqueRef(payload: BoundaryValue): string {
  if (!isJsonObject(payload)) return "";
  const ref = payload.ref;
  return isString(ref) && OPAQUE_REF.test(ref) ? ref : "";
}

/**
 * Render an incoming push into what may appear on a lock screen.
 *
 * Deliberately total: a malformed, stale or hostile payload produces the
 * generic notification rather than throwing, because a service worker that
 * throws in its `push` handler shows the browser's own "This site has been
 * updated in the background" instead — which is both uglier and less private
 * than saying nothing.
 */
export function pushNotificationBody(
  payload: BoundaryValue,
): PushNotificationView {
  const body = isJsonObject(payload) ? payload : {};
  const kind = isString(body.kind) ? body.kind : "";
  const action = isString(body.action) ? body.action : "";
  const ref = opaqueRef(payload);
  return {
    title: TITLES.get(kind) ?? DEFAULT_TITLE,
    body: BODIES.get(action) ?? DEFAULT_BODY,
    tag: ref ? `opensesame-approval-${ref}` : "opensesame-approval",
    data: { ref },
  };
}

/**
 * Where a click should land.
 *
 * Always inside the worker's own scope, always built from the vetted opaque
 * reference, never from anything else in the payload. A push whose reference
 * is missing or malformed opens the app itself, which is a harmless place to
 * be: a stale reference lands on the review page's own terminal state, and no
 * reference lands on the app's front door.
 */
export function reviewUrlFromPayload(
  payload: BoundaryValue,
  scope: string,
): string {
  const ref = opaqueRef(payload);
  const base = new URL(scope);
  return ref ? new URL(`approve/${ref}`, base).href : base.href;
}

/* ------------------------------------------------------------------ *
 * Enrolment
 * ------------------------------------------------------------------ */

export type PushErrorCode = "unsupported" | "denied" | "unavailable" | "failed";

export class PushError extends Error {
  constructor(
    readonly code: PushErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PushError";
  }
}

async function fetchFnDefault(
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(url, init);
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

export const pushSeams = {
  fetchFn: fetchFnDefault,
  serviceWorkerContainer: serviceWorkerContainerDefault,
  pushApiAvailable: pushApiAvailableDefault,
  requestPermission: requestPermissionDefault,
};

/** Both halves have to be there: a worker to receive it, and an API to ask. */
export function pushSupported(): boolean {
  return (
    pushSeams.serviceWorkerContainer() !== null && pushSeams.pushApiAvailable()
  );
}

export interface PushEnrolment {
  /** Identity API origin. */
  baseUrl: string;
  /** The enrolling person's session bearer. Used once, never stored here. */
  accessToken: string;
  /** Shown back to the person so they can tell two devices apart. */
  deviceLabel?: string;
}

export interface PushSubscriptionRecord {
  id: string;
  deviceLabel?: string;
  createdAt: string;
}

const trimBase = (base: string) => base.replace(/\/$/, "");

async function authorized(
  input: PushEnrolment,
  path: string,
  init: RequestInit,
  tolerate: readonly number[] = [],
): Promise<BoundaryValue> {
  let res: Response;
  try {
    res = await pushSeams.fetchFn(`${trimBase(input.baseUrl)}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${input.accessToken}`,
      },
    });
  } catch {
    throw new PushError(
      "unavailable",
      "The Identity API is not reachable from here, so notifications were not changed.",
    );
  }
  if (!res.ok && !tolerate.includes(res.status)) {
    throw new PushError(
      res.status === 404 ? "unsupported" : "failed",
      `The server refused that (${res.status}).`,
    );
  }
  return res.json().catch(() => null);
}

/** The VAPID application server key. Public by design; still fetched, never baked. */
export async function fetchApplicationServerKey(
  input: PushEnrolment,
): Promise<string> {
  const body = await authorized(input, "/v1/notification-channels/push/key", {
    method: "GET",
  });
  const key = isJsonObject(body) ? body.publicKey : undefined;
  if (!isString(key) || key.length === 0) {
    throw new PushError(
      "unsupported",
      "This deployment has no push signing key, so push notifications are not available here.",
    );
  }
  return key;
}

function b64urlToBytes(value: string): Uint8Array {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob((value + pad).replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const container = pushSeams.serviceWorkerContainer();
  if (!container) {
    throw new PushError(
      "unsupported",
      "This browser has no service worker here, so it cannot receive push notifications. That changes nothing about approving requests — they still wait for you in the app.",
    );
  }
  return container.ready;
}

/**
 * Subscribe this browser and register the subscription.
 *
 * `userVisibleOnly` is not negotiable: a push that shows nothing is a silent
 * wake-up, and the browsers that allow it are the ones this app has no reason
 * to trust more than the ones that do not.
 */
export async function enablePush(
  input: PushEnrolment,
): Promise<PushSubscriptionRecord> {
  if (!pushSupported()) {
    throw new PushError(
      "unsupported",
      "This browser cannot receive push notifications. Requests still wait for you in the app.",
    );
  }
  const permission = await pushSeams.requestPermission();
  if (permission !== "granted") {
    throw new PushError(
      "denied",
      "Notifications are blocked for this site, so nothing can be delivered here. Requests still wait for you in the app.",
    );
  }
  const worker = await registration();
  const existing = await worker.pushManager.getSubscription();
  const subscription =
    existing ??
    (await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: overlapCast(
        b64urlToBytes(await fetchApplicationServerKey(input)),
      ),
    }));

  const json = subscription.toJSON();
  const endpoint = json.endpoint ?? subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!isString(endpoint) || !isString(p256dh) || !isString(auth)) {
    throw new PushError(
      "failed",
      "This browser produced a push subscription without its keys, so it could not be registered.",
    );
  }

  const body = await authorized(
    input,
    "/v1/notification-channels/push/subscriptions",
    {
      method: "POST",
      body: JSON.stringify({
        endpoint,
        keys: { p256dh, auth },
        ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : undefined),
      }),
    },
  );
  return overlapCast(isJsonObject(body) ? body : {});
}

export interface PushWithdrawal {
  baseUrl: string;
  accessToken: string;
  /**
   * The id `enablePush` returned.
   *
   * A subscription is addressed by that opaque id rather than by its endpoint,
   * because the endpoint is a capability URL — anyone holding it can push to
   * that browser — and the server stores it without ever handing it back.
   * Without the id only the browser half can be undone, which is still the
   * half that matters to the person holding the phone.
   */
  subscriptionId?: string;
}

/**
 * Stop delivering here.
 *
 * The server is told first, and the local subscription is dropped either way —
 * a failed round trip must not leave a browser still receiving pushes it was
 * told to stop receiving. A subscription the server no longer knows about is
 * not an error: that is the state being asked for.
 */
export async function disablePush(input: PushWithdrawal): Promise<boolean> {
  const container = pushSeams.serviceWorkerContainer();
  if (!container) return false;
  const worker = await container.ready;
  const subscription = await worker.pushManager.getSubscription();
  if (!subscription) return false;
  try {
    if (input.subscriptionId) {
      await authorized(
        { baseUrl: input.baseUrl, accessToken: input.accessToken },
        `/v1/notification-channels/push/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
        { method: "DELETE" },
        // Already gone is the outcome we wanted.
        [404],
      );
    }
  } finally {
    await subscription.unsubscribe();
  }
  return true;
}

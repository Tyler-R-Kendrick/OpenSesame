import {
  type EgressDenialCode,
  EgressDenied,
} from "@opensesame/app-core/lib/capabilities/egress.js";
import {
  addPendingPushForget,
  clearPendingPushForget,
  pendingPushForgets,
} from "@opensesame/app-core/lib/web-push-ledger.js";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { b64urlToBytes } from "@opensesame/sdk-browser";
import {
  madeWith,
  pushRegistration,
  readyRegistration,
  subscribeNew,
} from "./push-browser.js";
import {
  PushError,
  type PushErrorCode,
  pushSeams,
  pushSupported,
} from "./push-seams.js";

export {
  PushError,
  type PushErrorCode,
  pushSeams,
  pushSupported,
} from "./push-seams.js";
export { pushSubscribed } from "./push-browser.js";

/**
 * Web Push enrolment (ADR 0084): the document's half. The service worker's
 * half — what a push may say on a lock screen — is `push.ts`, and this file
 * must never be imported from a worker.
 *
 * Enrolment is a conversation with three parties that can each say no: the
 * person (the `notifications` permission), the browser (a worker to receive
 * the push, a push service to subscribe against — `push-browser.ts`) and the
 * Identity API (a signing key to subscribe with, a record to keep). Every
 * refusal here is a `PushError` whose message says which party refused and
 * that requests still wait in the app, and a refusal never leaves a half: a
 * subscription this call created is dropped again if the Identity API did not
 * record it.
 */

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

/**
 * A failed call, said truthfully. A refusal by this installation's own egress
 * policy (`refusal`, its denial code) is not the network being down, and
 * telling the person the service is "not reachable" sent every investigation
 * to the wrong place.
 */
function unreachable(refusal: EgressDenialCode | null): PushError {
  if (refusal !== null) {
    return new PushError(
      "blocked",
      `This installation may not reach the sign-in service for push (${refusal}), so notifications were not changed.`,
    );
  }
  return new PushError(
    "unavailable",
    "The sign-in service is not reachable from here, so notifications were not changed.",
  );
}

/**
 * 404: the deployment has no such route. 409 has two meanings the service
 * tells apart: another principal holds the endpoint (a fresh subscription
 * recovers it), or this principal is at its limit (nothing here recovers it,
 * and a fresh subscription would only be made to be taken back).
 */
function refusalCode(status: number, reason: string | null): PushErrorCode {
  if (status === 404) return "unsupported";
  if (status === 409 && reason === "endpoint_already_registered")
    return "conflict";
  if (status === 409 && reason === "subscription_limit_reached") return "limit";
  return "failed";
}

async function reasonOf(res: Response): Promise<string | null> {
  const body: BoundaryValue = await res
    .clone()
    .json()
    .catch(() => null);
  return isJsonObject(body) && isString(body.error) ? body.error : null;
}

async function authorized(
  input: PushEnrolment,
  path: string,
  init: RequestInit,
  tolerate: readonly number[] = [],
): Promise<BoundaryValue> {
  // One bound over the request and the reading of its body: a service that
  // accepts the connection and then says nothing must not hold the key.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    pushSeams.requestTimeoutMs,
  );
  try {
    let res: Response;
    try {
      res = await pushSeams.fetchFn(`${trimBase(input.baseUrl)}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(init.headers ?? {}),
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${input.accessToken}`,
        },
      });
    } catch (caught) {
      throw unreachable(caught instanceof EgressDenied ? caught.code : null);
    }
    if (!res.ok && !tolerate.includes(res.status)) {
      throw new PushError(
        refusalCode(res.status, await reasonOf(res)),
        `The server refused that (${res.status}).`,
      );
    }
    return await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
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

const BLOCKED =
  "Notifications are blocked for this site, so nothing can be delivered here. Requests still wait for you in the app.";
const NOT_ALLOWED =
  "Notifications were not allowed for this site, so nothing can be delivered here. Requests still wait for you in the app.";

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
  await askPermission();
  const worker = await pushRegistration();
  const key = b64urlToBytes(await fetchApplicationServerKey(input));
  const { subscription, created } = await subscriptionFor(worker, key);
  try {
    return await record(input, subscription);
  } catch (caught) {
    if (caught instanceof PushError && caught.code === "conflict")
      return takeOver(input, worker, key, subscription);
    // A subscription this call made and the Identity API never recorded would
    // read as "On" and deliver nothing; take it back. So would one the browser
    // already held, when the service has said it will record no more for this
    // person: it lists nothing for it (an endpoint it knew would be replaced,
    // not counted against the limit), so the row would read On over a
    // subscription nothing can ever ring. Any other refusal (a session that
    // lapsed, a service that failed) may have left a working enrolment, and a
    // held subscription is left alone for it.
    if (created || (caught instanceof PushError && caught.code === "limit"))
      await subscription.unsubscribe().catch(() => false);
    throw caught;
  }
}

/**
 * The Identity API says another principal holds this browser's endpoint (a
 * shared browser where the last person left without turning push off). That
 * endpoint is theirs and keeps ringing here, and this person could never
 * enrol on it: drop the browser's subscription and take a fresh one, which has
 * an endpoint nobody holds, then register that.
 */
async function takeOver(
  input: PushEnrolment,
  worker: ServiceWorkerRegistration,
  key: Uint8Array,
  held: PushSubscription,
): Promise<PushSubscriptionRecord> {
  await held.unsubscribe().catch(() => false);
  const fresh = await subscribeNew(worker, key);
  try {
    return await record(input, fresh);
  } catch (caught) {
    await fresh.unsubscribe().catch(() => false);
    throw caught;
  }
}

async function askPermission(): Promise<void> {
  const permission = await pushSeams.requestPermission();
  if (permission === "granted") return;
  throw new PushError(
    "denied",
    permission === "denied" ? BLOCKED : NOT_ALLOWED,
  );
}

/** What to enrol, and whether this call made it. */
interface Subscribed {
  subscription: PushSubscription;
  created: boolean;
}

/** The subscription to enrol: the one held if it fits the key, else a new one. */
async function subscriptionFor(
  worker: ServiceWorkerRegistration,
  key: Uint8Array,
): Promise<Subscribed> {
  const existing = await worker.pushManager.getSubscription();
  if (existing && madeWith(existing, key))
    return { subscription: existing, created: false };
  // The server signs with another key now: the old subscription can never be
  // delivered to again, and `subscribe` would refuse to replace it.
  await existing?.unsubscribe().catch(() => false);
  return { subscription: await subscribeNew(worker, key), created: true };
}

/** Tell the Identity API about a subscription; its answer is the record. */
async function record(
  input: PushEnrolment,
  subscription: PushSubscription,
): Promise<PushSubscriptionRecord> {
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
  /** Identity API origin; with no session there is none to tell. */
  baseUrl?: string;
  accessToken?: string;
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

/** What `disablePush` actually undid; neither half is assumed from the other. */
export interface PushWithdrawn {
  /** A subscription was held here and is now dropped. */
  browser: boolean;
  /** The Identity API was told to forget it (already forgotten counts). */
  server: boolean;
}

/** Tell the Identity API to forget one subscription; already gone is fine. */
export async function forgetPushSubscription(
  input: PushEnrolment,
  subscriptionId: string,
): Promise<void> {
  await authorized(
    input,
    `/v1/notification-channels/push/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "DELETE" },
    // Already gone is the outcome we wanted.
    [404],
  );
}

/**
 * Stop delivering here.
 *
 * The server is told whenever there is an id and a session to tell it with —
 * even when the browser has already lost its subscription (a cleared site, a
 * browser that expired it), because the record on the server is then all that
 * is left — and the local subscription is dropped either way: a failed round
 * trip must not leave a browser still receiving pushes it was told to stop
 * receiving. A subscription the server no longer knows about is not an error:
 * that is the state being asked for. The result says which halves were done, so
 * a caller never reports "off" for a server that was not told.
 */
export async function disablePush(
  input: PushWithdrawal,
): Promise<PushWithdrawn> {
  const registration = await readyRegistration();
  const subscription = registration
    ? await registration.pushManager.getSubscription()
    : null;
  let server = false;
  try {
    if (input.subscriptionId && input.baseUrl && input.accessToken) {
      await forgetPushSubscription(
        { baseUrl: input.baseUrl, accessToken: input.accessToken },
        input.subscriptionId,
      );
      server = true;
    }
  } finally {
    await subscription?.unsubscribe();
  }
  return { browser: subscription !== null, server };
}

/**
 * Tell the Identity API to forget every id this browser stopped using — a
 * subscription dropped when the capability was removed, one the browser lost,
 * one a withdrawal could not report — and clear each as it is forgotten. Stops
 * at the first failure (the service is not reachable, or refused) and leaves
 * the rest for next time; never throws, because it is never the point of what
 * the person asked for.
 */
export async function flushPendingForgets(
  input: PushEnrolment,
  liveId: string | null,
): Promise<void> {
  for (const id of pendingPushForgets()) {
    // An id this browser is using again is not one to forget.
    if (id === liveId) {
      clearPendingPushForget(id);
      continue;
    }
    try {
      await forgetPushSubscription(input, id);
    } catch {
      return;
    }
    clearPendingPushForget(id);
  }
}

/** Keep an id the Identity API may still list, to be forgotten when it can be. */
export function keepToForget(id: string | null): void {
  if (id) addPendingPushForget(id);
}

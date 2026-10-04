import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

/**
 * The two pure functions the service worker uses to render what arrives
 * (ADR 0084). Enrolment — the document's half — is `push-enrolment.ts`; the
 * worker bundle must carry none of it.
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

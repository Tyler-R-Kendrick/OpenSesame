/**
 * Web Push (ADR 0084) — the handlers only the push variant ships.
 *
 * `sw-push.ts` imports this; `sw.ts` must not. A build of the core worker
 * that contained a `push` listener would mean an installation that never
 * accepted `notifications.web-push` still carried the code to show a
 * notification, and the tests on the listener table (PWA-01) hold it out.
 */

import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { pushNotificationBody, reviewUrlFromPayload } from "../lib/push.js";

/**
 * A push body is whatever arrived over the wire, which is to say: not to be
 * trusted and not to be shown. Parsing it here — and letting a malformed one
 * resolve to `null` rather than throw — keeps the decision about what a person
 * sees entirely inside `pushNotificationBody`, where the closed string table
 * lives.
 */
function pushPayload(event: PushEvent): BoundaryValue {
  if (!event.data) return null;
  try {
    return event.data.json();
  } catch {
    return null;
  }
}

async function openReview(sw: ServiceWorkerGlobalScope, url: string): Promise<void> {
  const windows = await sw.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    if (!client.url.startsWith(sw.registration.scope)) continue;
    await client.focus();
    // `navigate()` is not everywhere; where it is missing, focusing the
    // window the person already has open is still the better outcome than
    // opening a second copy of the app.
    const navigable: {
      navigate?: (target: string) => Promise<WindowClient | null>;
    } = overlapCast(client);
    if (navigable.navigate) await navigable.navigate(url).catch(() => null);
    return;
  }
  await sw.clients.openWindow(url);
}

export function installPushHandlers(sw: ServiceWorkerGlobalScope): void {
  /**
   * Ring the doorbell, and say nothing through the door.
   *
   * The notification carries a title, one of a fixed set of short bodies, and
   * an opaque reference. It never carries `authorizationDetails`, a comparison
   * value, a principal id, or a token — `pushNotificationBody` has no path
   * from the payload's text to the notification's text, so it cannot.
   */
  sw.addEventListener("push", (event) => {
    const view = pushNotificationBody(pushPayload(event));
    event.waitUntil(
      sw.registration.showNotification(view.title, {
        body: view.body,
        tag: view.tag,
        data: view.data,
      }),
    );
  });

  /**
   * Open the review, in a window the person already has if there is one.
   *
   * The URL is resolved against this worker's own registration scope from the
   * vetted opaque reference, so it is always same-origin and can never carry a
   * bearer. A stale or withdrawn reference still opens: landing on the review
   * page's "this request is no longer open" is the correct outcome, and it is
   * the review page's job to say so, not this handler's.
   */
  sw.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = reviewUrlFromPayload(
      overlapCast(event.notification.data),
      sw.registration.scope,
    );
    event.waitUntil(openReview(sw, url));
  });
}

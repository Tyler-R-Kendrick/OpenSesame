/// <reference lib="webworker" />

import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { pushNotificationBody, reviewUrlFromPayload } from "./lib/push.js";

// SAFETY: this file is a service worker; globalThis is ServiceWorkerGlobalScope
// at runtime, but the TS lib types do not overlap.
const sw: ServiceWorkerGlobalScope = overlapCast(globalThis);

const CACHE = "opensesame-pages-v3";
// @ts-expect-error replaced by vite-plugin-pwa during the service-worker build
const shell = self.__WB_MANIFEST.find(
  (entry: { url: string } | string) =>
    (isString(entry) ? entry : entry.url) === "index.html",
);
const fallback = new URL("index.html", sw.registration.scope).href;

function isolated(response: Response, requestUrl: URL): Response {
  if (response.status === 0) return response;
  // Broker popups must keep window.opener so postMessage can reach the RP
  // (ADR 0034). COOP same-origin would null opener and break delivery.
  if (requestUrl.pathname.includes("/broker/")) {
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        shell ? cache.add(isString(shell) ? shell : shell.url) : undefined,
      )
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter((name) => name !== CACHE)
              .map((name) => caches.delete(name)),
          ),
        ),
      sw.clients.claim(),
    ]),
  );
});

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  if (
    request.method !== "GET" ||
    new URL(request.url).origin !== sw.location.origin
  )
    return;
  event.respondWith(
    (async () => {
      const url = new URL(request.url);
      if (request.mode === "navigate") {
        try {
          const response = await fetch(request);
          // GitHub Pages has no SPA rewrite: deep links 404. Serve the shell.
          if (!response.ok) {
            const cached = await caches.match(fallback);
            if (cached) return isolated(cached, url);
            const shellResponse = await fetch(fallback);
            return isolated(shellResponse, url);
          }
          const cache = await caches.open(CACHE);
          await cache.put(fallback, response.clone());
          return isolated(response, url);
        } catch {
          const cached = await caches.match(fallback);
          if (cached) return isolated(cached, url);
          throw new Error("offline shell unavailable");
        }
      }
      const cached = await caches.match(request);
      return cached ?? fetch(request);
    })(),
  );
});

/* ------------------------------------------------------------------ *
 * Web Push (ADR 0081)
 * ------------------------------------------------------------------ */

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

/**
 * Ring the doorbell, and say nothing through the door.
 *
 * The notification carries a title, one of a fixed set of short bodies, and an
 * opaque reference. It never carries `authorizationDetails`, a comparison
 * value, a principal id, or a token — `pushNotificationBody` has no path from
 * the payload's text to the notification's text, so it cannot.
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
  event.waitUntil(
    (async () => {
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
        if (navigable.navigate) {
          await navigable.navigate(url).catch(() => null);
        }
        return;
      }
      await sw.clients.openWindow(url);
    })(),
  );
});

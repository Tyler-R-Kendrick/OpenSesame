/// <reference lib="webworker" />

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

const CACHE = "opensesame-pages-v3";
// @ts-expect-error replaced by vite-plugin-pwa during the service-worker build
const shell = self.__WB_MANIFEST.find(
  (entry: { url: string } | string) =>
    (typeof entry === "string" ? entry : entry.url) === "index.html",
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
        shell
          ? cache.add(typeof shell === "string" ? shell : shell.url)
          : undefined,
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

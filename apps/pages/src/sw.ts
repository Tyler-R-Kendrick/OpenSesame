/// <reference lib="webworker" />

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

const CACHE = "opensesame-pages-v1";
// @ts-expect-error replaced by vite-plugin-pwa during the service-worker build
const shell = self.__WB_MANIFEST.find(
  (entry: { url: string } | string) =>
    (typeof entry === "string" ? entry : entry.url) === "index.html",
);
const fallback = new URL("index.html", sw.registration.scope).href;

function isolated(response: Response): Response {
  if (response.status === 0) return response;
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
      if (request.mode === "navigate") {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE);
          await cache.put(fallback, response.clone());
          return isolated(response);
        } catch {
          const cached = await caches.match(fallback);
          if (cached) return isolated(cached);
          throw new Error("offline shell unavailable");
        }
      }
      const cached = await caches.match(request);
      return cached ?? fetch(request);
    })(),
  );
});

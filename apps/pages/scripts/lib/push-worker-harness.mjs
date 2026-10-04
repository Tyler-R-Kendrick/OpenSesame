/**
 * What `verify-push-worker.mjs` stands on: a real localhost origin serving
 * `dist/` as a static host does, and the reads it makes of the browser's
 * worker registrations and notifications. Workers bypass `context.route`, so
 * the origin is a socket, not an interception.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/**
 * `dist/` under `base`, as a static host serves it; a route is index.html.
 * `runtimeConfig` is what the deployment's `os-runtime-config.json` says, when
 * the walk needs a deployment that says something.
 */
export function serve(dist, base, runtimeConfig = null) {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const rel = pathname.startsWith(base)
      ? pathname.slice(base.length)
      : pathname.slice(1);
    if (rel === "os-runtime-config.json" && runtimeConfig !== null) {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      return response.end(JSON.stringify(runtimeConfig));
    }
    const file = path.join(dist, rel);
    if (rel && fs.existsSync(file) && fs.statSync(file).isFile()) {
      response.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      return response.end(fs.readFileSync(file));
    }
    if (/\.[a-z0-9]+$/i.test(rel)) {
      response.writeHead(404);
      return response.end("not found");
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(fs.readFileSync(path.join(dist, "index.html")));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

/** The worker script this scope runs, or what is installing over it. */
export const scriptsOf = (page, base) =>
  page.evaluate(
    async (scope) => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const own = registrations.filter((r) => r.scope === scope);
      return {
        registrations: registrations.length,
        active: own[0]?.active?.scriptURL ?? null,
        installing: own[0]?.installing?.scriptURL ?? null,
        waiting: own[0]?.waiting?.scriptURL ?? null,
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      };
    },
    `${new URL(page.url()).origin}${base}`,
  );

export async function until(read, ok, what, timeout = 60_000) {
  const stop = Date.now() + timeout;
  let last;
  while (Date.now() < stop) {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${what}: ${JSON.stringify(last)}`);
}

export const notificationsOf = (page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.getNotifications()).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      data: n.data,
    }));
  });

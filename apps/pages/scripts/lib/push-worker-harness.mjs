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

/**
 * Hold a context's pages until the core worker has taken the first one.
 *
 * A device's first load runs under no worker. The core worker installs
 * (precaching the shell, which takes as long as the machine is slow), claims
 * the page, and the page reloads once, by design: it does not yet know which
 * release it booted under (`onControllerChange`, `worker/plan-sync.ts`). A
 * walk that opens a guest vault before that reload loses it, and waits for a
 * "Lock vault" key that a reloaded front door never shows. `controller` being
 * set is not the signal: the reload follows it. A document born with a
 * controller is, and is not reloaded for the claim again.
 *
 * Call `trackControlledBirth(context)` before the context's first page loads,
 * then `await untilBornControlled(page)` before touching the door.
 */
export const trackControlledBirth = (context) =>
  context.addInitScript(() => {
    window.__osBornControlled =
      navigator.serviceWorker?.controller?.scriptURL ?? null;
  });

export const untilBornControlled = (page, timeout = 30_000) =>
  until(
    () => page.evaluate(() => window.__osBornControlled ?? null),
    (script) => script !== null && new URL(script).pathname.endsWith("/sw.js"),
    "the core worker to take the first load and the page to reload under it",
    timeout,
  );

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

const sameUrl = (a, b) =>
  a !== null &&
  b !== null &&
  new URL(a).origin === new URL(b).origin &&
  new URL(a).pathname === new URL(b).pathname;

/**
 * Wait for `script` to hold this page's scope, settled. A first install Chrome
 * leaves waiting is asked for again under a fresh `?r=<n>` URL
 * (`worker/activation.ts`), and that re-ask can still be in flight when the
 * original takes the scope; it settles on its own, and a walk checks the end
 * state.
 */
export const untilHeld = (page, base, script, what) =>
  until(
    () => scriptsOf(page, base),
    (s) =>
      sameUrl(s.active, script) &&
      sameUrl(s.controller, script) &&
      s.waiting === null &&
      s.installing === null,
    what,
  );

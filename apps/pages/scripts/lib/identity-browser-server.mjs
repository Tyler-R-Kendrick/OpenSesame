/** Serve the built app on a real loopback socket, retaining its actual address space. */
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { observeHttpFailures } from "./http-failures.mjs";
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "application/font-woff2",
};

export async function startIdentityAppServer(dist, origin, base) {
  const root = path.resolve(dist);
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    const relative = url.pathname.startsWith(base)
      ? url.pathname.slice(base.length)
      : url.pathname.slice(1);
    const candidate = path.resolve(root, relative);
    const isFile =
      candidate.startsWith(`${root}${path.sep}`) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile();
    if (!isFile && /\.[a-z0-9]+$/i.test(relative)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing asset");
      return;
    }
    const file = isFile ? candidate : path.join(root, "index.html");
    response.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(new URL(origin).port, "127.0.0.1", resolve);
  });
  return {
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export async function liveIdentityPage(browser, origin, providers, record) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  const allowed = new Set([origin, ...providers]);
  await context.route(
    (url) =>
      url.protocol !== "blob:" &&
      url.protocol !== "data:" &&
      !allowed.has(url.origin),
    (route) => {
      record("unexpected-external-request", route.request().url());
      return route.abort("connectionrefused");
    },
  );
  const page = await context.newPage();
  observeHttpFailures(page, record);
  page.on("pageerror", (error) =>
    record("PAGE-ERROR", String(error.stack ?? error)),
  );
  return { page, context };
}

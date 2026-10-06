/** Real HTTP shell and service worker; no intercepted application modules. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";
import {
  trackControlledBirth,
  untilBornControlled,
} from "./push-worker-harness.mjs";

const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

export async function retiredOfflineHarness({
  dist,
  base,
  passthrough = [],
  port = 0,
}) {
  const log = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const relative = pathname.startsWith(base)
      ? pathname.slice(base.length)
      : "";
    let file = path.resolve(dist, relative);
    if (
      !file.startsWith(`${path.resolve(dist)}${path.sep}`) &&
      file !== path.resolve(dist)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(dist, "index.html");
    response.writeHead(200, {
      "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
    });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://localhost:${address.port}`;
  return {
    log,
    origin,
    launch: (options = {}) =>
      chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
        headless: true,
        args: options.args ?? [],
      }),
    async newPage(browser, { device }) {
      const context = await browser.newContext({
        serviceWorkers: "allow",
        ...device,
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin ||
        passthrough.includes(new URL(route.request().url()).origin)
          ? route.continue()
          : route.abort("connectionrefused"),
      );
      await trackControlledBirth(context);
      const page = await context.newPage();
      page.on("pageerror", (error) =>
        log.push({ kind: "PAGE-ERROR", detail: error.message }),
      );
      await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
      await untilBornControlled(page);
      return { context, page };
    },
    settleFirstLoad: untilBornControlled,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

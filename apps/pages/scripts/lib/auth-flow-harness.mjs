import fs from "node:fs";
import path from "node:path";
import { observeHttpFailures } from "./http-failures.mjs";

export const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export function createAuthFlowHarness({
  DIST,
  ORIGIN,
  BASE,
  OUT,
  record,
}) {
  async function newPage(browser) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === ORIGIN) {
        const rel = url.pathname.startsWith(BASE)
          ? url.pathname.slice(BASE.length)
          : url.pathname.slice(1);
        const file = path.join(DIST, rel);
        if (rel && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
          return route.fulfill({
            status: 200,
            headers: {
              "content-type":
                MIME[path.extname(file)] ?? "application/octet-stream",
            },
            body: fs.readFileSync(file),
          });
        }
        return route.fulfill({
          status: rel ? 404 : 200,
          headers: { "content-type": "text/html" },
          body: fs.readFileSync(path.join(DIST, "index.html")),
        });
      }
      record("external-request", `${request.method()} ${request.url()}`);
      if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
        record("LOOPBACK-REQUEST", `${request.method()} ${request.url()}`);
      }
      return route.abort("connectionrefused");
    });
    const page = await context.newPage();
    observeHttpFailures(page, record);
    page.on("pageerror", (error) =>
      record("PAGE-ERROR", String(error?.stack ?? error).slice(0, 800)),
    );
    return { page, context };
  }

  async function snap(page, name, stepRef) {
    stepRef.current = name;
    await page.waitForTimeout(700);
    const text = await page.evaluate(() => document.body.innerText);
    const safe = name.replace(/[^a-z0-9]+/gi, "_");
    fs.writeFileSync(path.join(OUT, `${safe}.txt`), text);
    await page.screenshot({
      path: path.join(OUT, `${safe}.png`),
      fullPage: true,
    });
    return text;
  }

  const text = (page) => page.evaluate(() => document.body.innerText);

  return { newPage, snap, text };
}

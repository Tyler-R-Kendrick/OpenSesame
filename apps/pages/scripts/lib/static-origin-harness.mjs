/**
 * The harness behind `verify-static-origin.mjs`: how the production origin is
 * served out of `dist/`, what a mocked shoo.dev answers, what copy is
 * forbidden, and how a step is recorded, snapped and checked.
 *
 * Split from the checks so each half can be read on its own — and because the
 * structural ratchet asks anything touching an oversized file to leave it
 * smaller. The checks are the interesting half; this is the machinery.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

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

const b64url = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** An unsigned stand-in for Shoo's ES256 id_token; the page checks claims, not the signature. */
function idToken(origin) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://shoo.dev",
    aud: `origin:${origin}`,
    sub: "shoo-user-1",
    pairwise_sub: "pw_verify",
    email: "person@example.com",
    name: "Test Person",
    iat: now,
    exp: now + 3600,
  };
  return `${b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "k1" }))}.${b64url(JSON.stringify(payload))}.${b64url("sig")}`;
}

/**
 * Copy a deployment with no backend must never show.
 *
 * Two kinds. The first names something that is not there — a loopback address,
 * an identity service. The second reports a failure: on a deployment that asks
 * a Host nothing, "could not be read" describes a read that never happened.
 * Counting `role="alert"` alone missed exactly that, because the sentence was
 * a quiet hint rather than an alert, so the words themselves are the gate.
 */
const FORBIDDEN_COPY =
  /127\.0\.0\.1|localhost|No Identity API|Sign-in didn.t finish|could not be|couldn.t be|failed to|went wrong|is unavailable|unreachable/i;

/**
 * The deployment itself, served exactly as GitHub Pages serves it: a real file
 * where one exists, and index.html with a 404 status where the path is a route
 * rather than an asset. A missing asset is recorded, because a 404 for
 * something the page actually asked for is a fault.
 */
function serveFromDist(route, url, { dist, base, record }) {
  const rel = url.pathname.startsWith(base)
    ? url.pathname.slice(base.length)
    : url.pathname.slice(1);
  const file = path.join(dist, rel);
  if (rel && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      },
      body: fs.readFileSync(file),
    });
  }
  if (rel && /\.[a-z0-9]+$/i.test(rel)) {
    record("MISSING-ASSET", url.pathname);
    return route.fulfill({ status: 404, body: "not found" });
  }
  return route.fulfill({
    status: rel ? 404 : 200,
    headers: { "content-type": "text/html" },
    body: fs.readFileSync(path.join(dist, "index.html")),
  });
}

/**
 * Shoo's two CORS-enabled browser endpoints, and nothing else: the token
 * exchange and the session check the return leg depends on. Answers null for
 * anything else, so an unexpected call to the broker is refused like any other
 * external request rather than quietly succeeding.
 */
function answerShoo(route, url, { request, origin }) {
  const cors = {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  if (request.method() === "OPTIONS") {
    return route.fulfill({ status: 204, headers: cors });
  }
  const json = (body) =>
    route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  if (url.pathname === "/token") {
    return json({
      id_token: idToken(origin),
      pairwise_sub: "pw_verify",
      expires_in: 3600,
    });
  }
  if (url.pathname === "/session/check") return json({ status: "active" });
  return null;
}

async function newPage(browser, { shoo = false, dist, origin, base, record }) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  const shooCalls = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) {
      return serveFromDist(route, url, { dist, base, record });
    }
    record("external-request", `${request.method()} ${request.url()}`);
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
      record("LOOPBACK-REQUEST", `${request.method()} ${request.url()}`);
    }
    if (shoo && url.origin === "https://shoo.dev") {
      shooCalls.push({
        method: request.method(),
        path: url.pathname,
        body: request.postData(),
      });
      const answered = answerShoo(route, url, { request, origin });
      if (answered) return answered;
    }
    if (request.isNavigationRequest()) {
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<html><body>EXTERNAL ${request.url()}</body></html>`,
      });
    }
    return route.abort("connectionrefused");
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error")
      record("console-error", message.text().slice(0, 400));
  });
  page.on("pageerror", (error) =>
    record("PAGE-ERROR", String(error?.stack ?? error).slice(0, 800)),
  );
  return { page, context, shooCalls };
}

async function snap(page, { name, out, record, setStep }) {
  setStep(name);
  await page.waitForTimeout(900);
  const text = await page.evaluate(() => document.body.innerText);
  const safe = name.replace(/[^a-z0-9]+/gi, "_");
  fs.writeFileSync(path.join(out, `${safe}.txt`), text);
  await page.screenshot({
    path: path.join(out, `${safe}.png`),
    fullPage: true,
  });
  for (const line of text.split("\n")) {
    if (FORBIDDEN_COPY.test(line)) {
      record("ON-SCREEN", line.trim().slice(0, 300));
    }
  }
  return text;
}

/**
 * Everything the checks need, closed over one deployment's paths.
 *
 * The log, the failures and the current step are the harness's own state: a
 * check names only what it is asserting, because where it was standing is
 * already known.
 */
export function createHarness({ dist, origin, base, out }) {
  const log = [];
  const failures = [];
  let step = "boot";
  const record = (kind, detail) => log.push({ step, kind, detail });
  const setStep = (next) => {
    step = next;
  };

  return {
    log,
    failures,
    record,
    setStep,
    check(condition, what) {
      if (!condition) failures.push(`[${step}] ${what}`);
      record(condition ? "PASS" : "FAIL", what);
    },
    launch: () =>
      chromium.launch({
        ...(process.env.PLAYWRIGHT_CHROMIUM
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
          : {}),
        headless: true,
      }),
    newPage: (browser, options = {}) =>
      newPage(browser, { ...options, dist, origin, base, record }),
    snap: (page, name) => snap(page, { name, out, record, setStep }),
  };
}

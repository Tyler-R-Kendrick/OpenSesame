// Prove the built Pages bundle works as a static front end with NO backend,
// under the real production origin (ADR 0090).
//
//   pnpm --filter @opensesame/pages build   (VITE_BASE=/OpenSesame/)
//   node apps/pages/scripts/verify-static-origin.mjs
//
// Every request to the production origin is served from `dist/` (unknown
// paths fall back to index.html with a 404 status, exactly as GitHub Pages
// does); every other origin is refused — except a mocked shoo.dev for the
// Google return leg. The run fails on any page error, any console error
// other than the SPA-fallback 404, any request to a loopback address, any
// missing asset, or any failed check below.
//
//   A. first screen: sign-in with the compiled broker + guest, no setup wall
//   B. guest → inside the app → every section, and every tab within Access,
//      by in-app navigation
//   C. Google via Shoo: the authorize request, then the return leg against a
//      mocked /token + /session/check, landing unlocked with the person named
//   D. deep link: the icon resolves under the base, not under the route
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "static-origin"),
);
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

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const b64url = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** An unsigned stand-in for Shoo's ES256 id_token; the page checks claims, not the signature. */
function idToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://shoo.dev",
    aud: `origin:${ORIGIN}`,
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

const log = [];
let step = "boot";
const record = (kind, detail) => log.push({ step, kind, detail });
const failures = [];
function check(condition, what) {
  if (!condition) failures.push(`[${step}] ${what}`);
  record(condition ? "PASS" : "FAIL", what);
}

async function newPage(browser, { shoo = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  const shooCalls = [];
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
      if (rel && /\.[a-z0-9]+$/i.test(rel)) {
        record("MISSING-ASSET", url.pathname);
        return route.fulfill({ status: 404, body: "not found" });
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
    if (shoo && url.origin === "https://shoo.dev") {
      shooCalls.push({
        method: request.method(),
        path: url.pathname,
        body: request.postData(),
      });
      const cors = {
        "access-control-allow-origin": ORIGIN,
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "POST, OPTIONS",
      };
      if (request.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: cors });
      if (url.pathname === "/token") {
        return route.fulfill({
          status: 200,
          headers: { ...cors, "content-type": "application/json" },
          body: JSON.stringify({
            id_token: idToken(),
            pairwise_sub: "pw_verify",
            expires_in: 3600,
          }),
        });
      }
      if (url.pathname === "/session/check") {
        return route.fulfill({
          status: 200,
          headers: { ...cors, "content-type": "application/json" },
          body: JSON.stringify({ status: "active" }),
        });
      }
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

async function snap(page, name) {
  step = name;
  await page.waitForTimeout(900);
  const text = await page.evaluate(() => document.body.innerText);
  const safe = name.replace(/[^a-z0-9]+/gi, "_");
  fs.writeFileSync(path.join(OUT, `${safe}.txt`), text);
  await page.screenshot({
    path: path.join(OUT, `${safe}.png`),
    fullPage: true,
  });
  for (const line of text.split("\n")) {
    if (FORBIDDEN_COPY.test(line)) {
      record("ON-SCREEN", line.trim().slice(0, 300));
    }
  }
  return text;
}

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {}),
  headless: true,
});

// ---- A + B: first screen, then guest through every section
{
  const { page, context } = await newPage(browser);
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  const text = await snap(page, "A-first-screen");
  check(/^Sign in$/m.test(text), "first screen is Sign in");
  check(!/This device is empty/.test(text), "no setup wall");
  check(
    (await page
      .getByRole("button", { name: "Continue with Google" })
      .count()) === 1,
    "Google button present",
  );
  check(
    (await page
      .getByRole("button", { name: "Continue as guest", exact: true })
      .count()) === 1,
    "guest button present",
  );
  check(
    (await page
      .getByRole("button", { name: "Skip sign-in and continue as guest" })
      .count()) === 1,
    "Skip link present",
  );
  check(
    (await page
      .getByRole("button", { name: "Use without an account" })
      .count()) === 1,
    "local-only road present",
  );
  check(
    (await page.getByRole("button", { name: "Deployment setup" }).count()) ===
      1,
    "setup reachable from the foot",
  );
  check(
    (await page.getByRole("button", { name: "Join a session" }).count()) === 1,
    "join reachable from the foot",
  );
  const icon = await page.evaluate(() =>
    document.querySelector('link[rel="icon"]')?.getAttribute("href"),
  );
  check(icon === `${BASE}icon.svg`, `icon href is base-rooted (${icon})`);

  await page.getByRole("button", { name: "Deployment setup" }).click();
  await snap(page, "A2-setup");
  check(
    /How do people sign in\?/.test(
      await page.evaluate(() => document.body.innerText),
    ),
    "setup opens on purpose",
  );
  await page.getByRole("button", { name: "Back" }).click();
  await page.waitForTimeout(300);
  check(
    /^Sign in$/m.test(await page.evaluate(() => document.body.innerText)),
    "back returns to sign-in",
  );

  await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .click();
  await page.waitForTimeout(2500);
  const inApp = await snap(page, "B-guest-in-app");
  check(/guest\s*@\s*guest/.test(inApp), "guest landed inside the app");
  check(!/Claim this guest session/.test(inApp), "no claim notice");

  for (const [label, name] of [
    ["connections/", "B-connections"],
    ["access/", "B-access"],
    ["identity/", "B-identity"],
    ["settings/", "B-settings"],
  ]) {
    step = name;
    // The rail lists sections as links; fall back to the visible label.
    const link = page
      .getByRole("link", { name: new RegExp(`^${label.replace("/", "\\/")}`) })
      .first();
    if (await link.count()) await link.click();
    else await page.getByText(label, { exact: true }).first().click();
    await page.waitForTimeout(1200);
    const sectionText = await snap(page, name);
    check(
      !/Something went wrong|Uncaught/i.test(sectionText),
      `${name} rendered`,
    );
    check(
      (await page.locator('[role="alert"]').count()) === 0,
      `${name} shows no alert`,
    );

    // Sections with tabs hide their regressions one click in: the whole of
    // Access was once gated on a Host, which hid the Sites — Identity-plane
    // clients plus wholly local snippets, domain rules and consents. A walk
    // that only ever saw each section's first tab could not see it.
    if (name === "B-access") {
      for (const tab of [
        "Grants",
        "Requests",
        "Sessions",
        "Resources",
        "Policies",
      ]) {
        step = `${name}-${tab}`;
        await page.getByRole("tab", { name: tab }).click();
        await page.waitForTimeout(700);
        const tabText = await snap(page, `${name}-${tab}`);
        check(
          !/Something went wrong|Uncaught/i.test(tabText),
          `Access › ${tab} rendered`,
        );
        check(
          (await page.locator('[role="alert"]').count()) === 0,
          `Access › ${tab} shows no alert`,
        );
      }
      // Resources is served by the Identity API and this browser, never the
      // Host, so it must render its own panel rather than a Host note.
      await page.getByRole("tab", { name: "Resources" }).click();
      await page.waitForTimeout(700);
      check(
        (await page.getByRole("heading", { name: "Resources" }).count()) > 0,
        "Access › Resources renders without a Host",
      );
    }
  }
  for (const category of [
    "general",
    "security",
    "data",
    "vaults",
    "connectivity",
    "danger",
  ]) {
    step = `B-settings-${category}`;
    const tab = page
      .getByRole("link", { name: new RegExp(`^${category}`, "i") })
      .first();
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(900);
      await snap(page, `B-settings-${category}`);
      check(
        (await page.locator('[role="alert"]').count()) === 0,
        `settings/${category} shows no alert`,
      );
    }
  }
  await context.close();
}

// ---- C: Google via Shoo, there and back
{
  const { page, context, shooCalls } = await newPage(browser, { shoo: true });
  step = "C-google";
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.waitForTimeout(2000);
  const authorize = new URL(page.url());
  check(
    authorize.origin === "https://shoo.dev" &&
      authorize.pathname === "/authorize",
    "navigated to shoo authorize",
  );
  check(
    authorize.searchParams.get("client_id") === `origin:${ORIGIN}`,
    "client_id is the origin profile",
  );
  check(
    authorize.searchParams.get("redirect_uri") === `${ORIGIN}${BASE}`,
    "redirect_uri is the app base",
  );
  check(
    authorize.searchParams.get("code_challenge_method") === "S256",
    "PKCE S256",
  );
  check(
    !authorize.searchParams.has("response_type") &&
      !authorize.searchParams.has("scope"),
    "shoo dialect",
  );
  const state = authorize.searchParams.get("state") ?? "";

  await page.goto(
    `${ORIGIN}${BASE}?code=verify-code&state=${encodeURIComponent(state)}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForTimeout(3500);
  const landed = await snap(page, "C-after-return");
  const token = shooCalls.find(
    (call) => call.path === "/token" && call.method === "POST",
  );
  check(Boolean(token), "POST /token exchanged the code");
  check(
    Boolean(
      token?.body?.includes("code_verifier=") &&
        token?.body?.includes("client_id=origin"),
    ),
    "token request carries verifier + origin client id",
  );
  check(
    shooCalls.some(
      (call) => call.path === "/session/check" && call.method === "POST",
    ),
    "POST /session/check validated the user",
  );
  check(!/Sign-in didn.t finish/.test(landed), "no failure card");
  check(
    /@/.test(landed) && !/^Sign in$/m.test(landed),
    "landed inside the app",
  );
  check(
    !/Finish attaching|Claim this guest|Identity is reachable/.test(landed),
    "no pending-link noise",
  );
  check(/test person/i.test(landed), "prompt names the signed-in person");
  const session = await page.evaluate(() =>
    localStorage.getItem("opensesame:federation:session"),
  );
  check(
    Boolean(session?.includes("pw_verify")),
    "federation session saved on device",
  );
  await context.close();
}

// ---- D: deep link asset resolution
{
  const { page, context } = await newPage(browser);
  step = "D-deeplink";
  await page.goto(`${ORIGIN}${BASE}vault/health`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const missing = log.filter(
    (entry) => entry.kind === "MISSING-ASSET" && entry.step === "D-deeplink",
  );
  check(
    missing.length === 0,
    `no missing asset on a deep link ${missing.map((m) => m.detail).join(", ")}`,
  );
  await context.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));

const loopback = log.filter((entry) => entry.kind === "LOOPBACK-REQUEST");
const pageErrors = log.filter((entry) => entry.kind === "PAGE-ERROR");
const consoleErrors = log.filter(
  (entry) =>
    entry.kind === "console-error" && !/404 \(Not Found\)/.test(entry.detail),
);
const onScreen = log.filter(
  (entry) =>
    entry.kind === "ON-SCREEN" && !/^Not connected$/.test(entry.detail),
);
const missingAssets = log.filter((entry) => entry.kind === "MISSING-ASSET");
for (const entry of log)
  if (entry.kind === "PASS" || entry.kind === "FAIL")
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);
console.log(`loopback requests: ${loopback.length}`);
console.log(
  `page errors: ${pageErrors.length}`,
  pageErrors.map((e) => `[${e.step}] ${e.detail.slice(0, 200)}`),
);
console.log(
  `console errors: ${consoleErrors.length}`,
  consoleErrors.map((e) => `[${e.step}] ${e.detail.slice(0, 200)}`),
);
console.log(
  "on-screen backend/localhost mentions:",
  onScreen.map((e) => `[${e.step}] ${e.detail}`),
);
console.log(
  "missing assets:",
  missingAssets.map((e) => `[${e.step}] ${e.detail}`),
);
const hard =
  loopback.length +
  pageErrors.length +
  consoleErrors.length +
  onScreen.length +
  missingAssets.length;
if (failures.length || hard) {
  console.log(
    `\n${failures.length} failed checks, ${hard} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);

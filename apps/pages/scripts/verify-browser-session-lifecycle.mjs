// Native window-hide and bfcache restoration against the shipped Pages build.
// Observes browser events. Does not dispatch visibilitychange or pageshow,
// and does not assign document.hidden.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import {
  WATCH_RTC,
  joinerAsks,
  joinerConnects,
  ownerAdmitsByHand,
  ownerEnters,
  startSession,
} from "./lib/live-join-walk.mjs";
import { openSettingsCategory } from "./lib/pages-journey.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
const base = "/OpenSesame/";
const secret = "correct-horse-battery-staple-2026";
const joinerName = "Ada";
const mode = process.argv[2];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

if (mode !== "hide" && mode !== "bfcache") {
  throw new Error("usage: verify-browser-session-lifecycle.mjs hide|bfcache");
}
if (!fs.existsSync(path.join(dist, "index.html"))) {
  throw new Error("Build Pages before verify-browser-session-lifecycle.");
}

class Unverifiable extends Error {
  constructor(message) {
    super(message);
    this.name = "Unverifiable";
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // A different document, so history-back can freeze the Pages document.
    // No Cache-Control: a no-store response is ineligible for the back/forward cache.
    if (url.pathname === "/outside.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>outside</title><p>outside</p>");
      return;
    }
    let rel = url.pathname;
    if (rel === "/OpenSesame") rel = "/OpenSesame/";
    if (!rel.startsWith(base)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const name = rel.slice(base.length);
    const file = path.join(dist, name);
    if (name && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(fs.readFileSync(file));
      return;
    }
    if (name && /\.[a-z0-9]+$/i.test(name)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(dist, "index.html")));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address?.port ?? 0;
      resolve({ server, origin: `http://localhost:${port}` });
    });
  });
}

async function ensureDisplay() {
  if (process.env.DISPLAY) {
    console.log(`display=${process.env.DISPLAY} started=false`);
    return null;
  }
  const display = `:${100 + (process.pid % 80)}`;
  const child = spawn(
    "Xvfb",
    [display, "-screen", "0", "1400x900x24", "-ac", "-nolisten", "tcp"],
    { stdio: "ignore" },
  );
  process.env.DISPLAY = display;
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode !== null) {
    throw new Unverifiable(
      `Xvfb exited ${child.exitCode} before Chromium launched`,
    );
  }
  console.log(`display=${display} started=true`);
  return child;
}

function launch() {
  return chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM || chromium.executablePath(),
    headless: false,
    // Playwright's defaults force the page to stay visible and disable bfcache.
    ignoreDefaultArgs: [
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-back-forward-cache",
    ],
    args: [
      "--allow-loopback-in-peer-connection",
      "--disable-features=WebRtcHideLocalIpsWithMdns,LocalNetworkAccessChecks",
    ],
  });
}

async function device(browser) {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 700 },
    serviceWorkers: "block",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await context.addInitScript(WATCH_RTC);
  await context.addInitScript(() => {
    const slot = { hides: [], shows: [] };
    window.__life = slot;
    document.addEventListener(
      "visibilitychange",
      (event) => {
        slot.hides.push({
          trusted: event.isTrusted,
          state: document.visibilityState,
        });
      },
      true,
    );
    window.addEventListener("pageshow", (event) => {
      const entries = performance.getEntriesByType("navigation");
      slot.shows.push({
        trusted: event.isTrusted,
        persisted: event.persisted,
        navTypes: entries.map((entry) => entry.type),
      });
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    console.log(`PAGE-ERROR ${String(error).slice(0, 400)}`);
  });
  return { context, page };
}

async function connectPair(origin, owner, joiner) {
  await ownerEnters(owner, { origin, base, secret });
  const { panel, code, link } = await startSession(owner);
  const request = await joinerAsks(joiner, { link, code, name: joinerName });
  const reply = await ownerAdmitsByHand(owner, panel, request, joinerName);
  await joinerConnects(joiner, reply);
  await joiner.getByRole("button", { name: "Reveal GitHub Password" }).click();
  await expect(joiner.getByText(secret)).toBeVisible({ timeout: 45_000 });
  console.log("peer read the shared field before the lifecycle event");
  return panel;
}

async function refused(joiner) {
  await joiner
    .getByRole("img", { name: "The session ended" })
    .waitFor({ timeout: 20_000 });
  const left = await joiner.getByText(secret).count();
  console.log(`peer secret count after retire=${left}`);
  if (left !== 0) throw new Error("peer can still read the shared field");
}

async function windowClient(page) {
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  let windowId;
  try {
    const got = await client.send("Browser.getWindowForTarget");
    windowId = got.windowId;
  } catch (error) {
    throw new Unverifiable(
      `window manager cannot name the browser window: ${error instanceof Error ? error.message : error}`,
    );
  }
  return { client, windowId };
}

async function hideJourney(origin, owner, joiner) {
  await connectPair(origin, owner.page, joiner.page);
  await openSettingsCategory(owner.page, "General");
  const toggle = owner.page.getByRole("switch", {
    name: "Lock when this tab goes to the background",
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  console.log("lock-on-hide=on");
  const { client, windowId } = await windowClient(owner.page);
  let minimized;
  try {
    minimized = await client.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
  } catch (error) {
    throw new Unverifiable(
      `window manager cannot minimize: ${error instanceof Error ? error.message : error}`,
    );
  }
  console.log(`minimize result=${JSON.stringify(minimized ?? null)}`);
  const bounds = await client.send("Browser.getWindowForTarget");
  console.log(`window bounds after minimize=${JSON.stringify(bounds.bounds)}`);
  if (bounds.bounds?.windowState !== "minimized") {
    throw new Unverifiable(
      `window manager left the window ${bounds.bounds?.windowState ?? "unknown"}`,
    );
  }
  let hidden = false;
  try {
    await owner.page.waitForFunction(
      () =>
        (window.__life?.hides ?? []).some(
          (entry) => entry.trusted === true && entry.state === "hidden",
        ),
      { timeout: 5_000 },
    );
    hidden = true;
  } catch {
    hidden = false;
  }
  const fact = await owner.page.evaluate(() => ({
    visibility: document.visibilityState,
    hides: window.__life?.hides ?? [],
  }));
  console.log(`visibility after minimize=${fact.visibility}`);
  console.log(`hide events=${JSON.stringify(fact.hides)}`);
  if (!hidden || fact.visibility !== "hidden") {
    throw new Error("minimized window did not deliver a trusted hidden state");
  }
  await refused(joiner.page);
  await client.send("Browser.setWindowBounds", {
    windowId,
    bounds: { windowState: "normal" },
  });
  await owner.page.waitForTimeout(1_000);
  const restored = await owner.page.evaluate(() => document.visibilityState);
  console.log(`visibility after restore=${restored}`);
  await refused(joiner.page);
  const live = await owner.page
    .locator("#live-session")
    .getByRole("img", { name: "Live" })
    .count();
  console.log(`owner live marks after restore=${live}`);
  if (live !== 0) throw new Error("restoring the window revived the session");
}

async function bfcacheJourney(origin, owner, joiner) {
  await connectPair(origin, owner.page, joiner.page);
  await owner.page.goto(`${origin}/outside.html`, { waitUntil: "load" });
  await owner.page.getByText("outside", { exact: true }).waitFor();
  await refused(joiner.page);
  await owner.page.goBack({ waitUntil: "commit" });
  await owner.page.waitForTimeout(800);
  const fact = await owner.page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation");
    const latest = nav[nav.length - 1];
    return {
      href: location.href,
      shows: window.__life?.shows ?? [],
      navTypes: nav.map((entry) => entry.type),
      reasons: latest ? (latest.notRestoredReasons ?? null) : null,
    };
  });
  console.log(`href after back=${fact.href}`);
  console.log(`pageshow events=${JSON.stringify(fact.shows)}`);
  console.log(`navigation types=${JSON.stringify(fact.navTypes)}`);
  console.log(`notRestoredReasons=${JSON.stringify(fact.reasons)}`);
  // A bfcache restore keeps the original PerformanceNavigationTiming entry
  // (often "navigate"). `pageshow.persisted` is the browser's restore signal.
  // "back_forward" here would be a fresh history load, which is not this gate.
  const shows = fact.shows ?? [];
  const trustedPersisted = shows.some(
    (entry) => entry.trusted === true && entry.persisted === true,
  );
  const reload = (fact.navTypes ?? []).includes("reload");
  if (reload) {
    throw new Error("history return reloaded the document");
  }
  if (!trustedPersisted) {
    throw new Unverifiable(
      "Chromium did not deliver pageshow.persisted=true from history",
    );
  }
  await refused(joiner.page);
  const live = await owner.page
    .locator("#live-session")
    .getByRole("img", { name: "Live" })
    .count();
  console.log(`owner live marks after bfcache=${live}`);
  if (live !== 0) throw new Error("bfcache restore revived the session");
}

let verdict = "fail";
let xvfb = null;
let server;
const browsers = [];
try {
  console.log(`mode=${mode}`);
  xvfb = await ensureDisplay();
  const started = await startServer();
  server = started.server;
  console.log(`origin=${started.origin}`);
  const ownerBrowser = await launch();
  const joinerBrowser = await launch();
  browsers.push(ownerBrowser, joinerBrowser);
  const owner = await device(ownerBrowser);
  const joiner = await device(joinerBrowser);
  if (mode === "hide") await hideJourney(started.origin, owner, joiner);
  else await bfcacheJourney(started.origin, owner, joiner);
  verdict = "pass";
} catch (error) {
  verdict = error instanceof Unverifiable ? "unverifiable" : "fail";
  console.log(
    `ERROR ${error instanceof Error ? (error.stack ?? error.message) : error}`,
  );
} finally {
  console.log(`VERDICT ${verdict}`);
  await Promise.all(browsers.map((browser) => browser.close().catch(() => {})));
  if (server) await new Promise((resolve) => server.close(resolve));
  xvfb?.kill();
}
process.exit(verdict === "pass" ? 0 : verdict === "unverifiable" ? 2 : 1);

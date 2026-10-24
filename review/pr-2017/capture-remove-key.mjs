#!/usr/bin/env node
/**
 * Evidence driver (ignored scratch, never committed): Connections › GitHub
 * with a GitHub App registered from this browser, and what a press of
 * "Remove GitHub App from this device" does (PR #2017, 819b480d3).
 *
 *   node capture-remove-key.mjs <before|after> <journey.json>
 *
 * The app's own Manifest flow registers the App: a guest switches External
 * connectors on, opens Connections › GitHub and presses Create GitHub App.
 * github.com's form endpoint and api.github.com are stood in for (the form
 * answers GitHub's redirect with a one-time code; the conversion answers a
 * throwaway App with a freshly generated RSA key). Every other request goes
 * through the repository's static-origin harness unchanged. Then the shot of
 * the Saved app row, one press of the remove key, and the shot after it, with
 * any browser dialog recorded and dismissed (the App is kept).
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureShotsDirectory } from "../../../../../apps/pages/scripts/lib/evidence-paths.mjs";
import { doorGuest } from "../../../../../apps/pages/scripts/lib/front-door.mjs";
import { phoneContext } from "../../../../../apps/pages/scripts/lib/mobile-contract.mjs";
import { addCapabilities } from "../../../../../apps/pages/scripts/lib/pages-journey.mjs";
import { createHarness } from "../../../../../apps/pages/scripts/lib/static-origin-harness.mjs";

const [label, journeyPath] = process.argv.slice(2);
const journey = JSON.parse(fs.readFileSync(journeyPath, "utf8"));
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../../..");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const DIST = process.env.EVIDENCE_DIST ?? path.join(ROOT, "apps/pages/dist");
const into = path.join(captureShotsDirectory(journeyPath), label);
fs.rmSync(into, { recursive: true, force: true });
fs.mkdirSync(into, { recursive: true });
const OUT = fs.mkdtempSync(path.join(captureShotsDirectory(journeyPath), "walk-"));
const harness = createHarness({ dist: DIST, origin: ORIGIN, base: BASE, out: OUT });
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP = {
  id: 424242,
  slug: "opensesame-evidence",
  name: "OpenSesame evidence",
  client_id: "Iv1.evidence0000000",
  owner: { login: "evidence-owner", type: "User" },
  html_url: "https://github.com/apps/opensesame-evidence",
};
const CORS = {
  "access-control-allow-origin": ORIGIN,
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
  "access-control-allow-headers": "authorization, content-type, accept, x-github-api-version",
};

/** github.com's manifest form and api.github.com, stood in for. */
async function standInForGithub(context) {
  await context.route("https://api.github.com/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status, body) =>
      route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    console.log(`  api.github.com ${request.method()} ${url.pathname}`);
    if (request.method() === "POST" && url.pathname === "/app-manifests/evidence-code/conversions")
      return json(201, { ...APP, client_secret: "evidence-client-secret", webhook_secret: null, pem: privateKey });
    if (request.method() === "GET" && url.pathname === "/app") return json(200, APP);
    if (request.method() === "GET" && url.pathname === "/app/installations") return json(200, []);
    return json(404, { message: "Not Found" });
  });
  await context.route("https://github.com/settings/apps/new**", (route) => {
    const request = route.request();
    const state = new URL(request.url()).searchParams.get("state");
    const manifest = JSON.parse(new URLSearchParams(request.postData() ?? "").get("manifest"));
    const back = new URL(manifest.redirect_url);
    back.searchParams.set("code", "evidence-code");
    back.searchParams.set("state", state);
    console.log(`  github.com manifest form → ${back.pathname}${back.search.replace(/state=[^&]+/, "state=…")}`);
    // Not a 302: Chromium sends a fulfilled redirect's next hop past the
    // context's routes, to the live deployment. A page that moves on keeps
    // the return on the build under test.
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<!doctype html><title>GitHub</title><script>location.replace(${JSON.stringify(back.toString())})</script>`,
    });
  });
}

const box = (locator) =>
  locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`;
  });
async function keys(page) {
  const found = page.locator(
    'button[aria-label*="GitHub App"]:visible, button[title*="GitHub App"]:visible',
  );
  const out = [];
  for (const key of await found.all()) {
    const name = (await key.getAttribute("aria-label")) ?? (await key.getAttribute("title"));
    out.push(`"${name}" class="${await key.getAttribute("class")}" aria-pressed=${await key.getAttribute("aria-pressed")} ${await box(key)}`);
  }
  return out;
}
const focusOf = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el && el !== document.body ? `${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40)}"` : "body";
  });
async function openGithub(page) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${BASE}connections/github`);
  await page.waitForTimeout(2500);
}

const browser = await harness.launch();
try {
  for (const screen of journey.screens) {
    console.log(`screen ${screen.name} ${screen.width}x${screen.height}`);
    const { page, context } = await harness.newPage(browser, {
      device: screen.desktop
        ? { viewport: { width: screen.width, height: screen.height } }
        : phoneContext({ width: screen.width, height: screen.height }),
    });
    await standInForGithub(context);
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") console.log(`  console.${m.type()}: ${m.text().slice(0, 300)}`);
    });
    page.on("response", (r) => {
      if (r.status() === 404 && /\.js$/.test(new URL(r.url()).pathname))
        console.log(`  404 ${new URL(r.url()).pathname} type=${r.request().resourceType()} frame=${r.frame()?.url().replace(ORIGIN, "")} worker=${r.request().serviceWorker() ? 1 : 0}`);
    });
    context.on("weberror", (e) => console.log(`  weberror ${String(e.error()).slice(0, 200)}`));
    const dialogs = [];
    page.on("dialog", (dialog) => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(5200);
    await doorGuest(page).click();
    await page.waitForTimeout(1500);
    await addCapabilities(page, ["External connectors"]);
    await openGithub(page);
    const create = page.getByRole("button", { name: "Create GitHub App", exact: true }).first();
    await create.waitFor({ timeout: 30_000 });
    await create.click();
    await page.waitForURL(/github_app=claim/, { timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    const remove0 = page.getByRole("button", { name: "Remove GitHub App from this device", exact: true });
    await remove0
      .or(doorGuest(page))
      .or(page.getByRole("button", { name: /^Unlock/ }))
      .first()
      .waitFor({ timeout: 60_000 })
      .catch(() => {});
    await page.waitForTimeout(3000);
    console.log(`  after return: remove=${await remove0.count()} door=${await doorGuest(page).count()} unlock=${await page.getByRole("button", { name: /^Unlock/ }).count()} flash="${(await page.locator("[role=img][aria-label*='GitHub App']").evaluateAll((n) => n.map((x) => x.getAttribute("aria-label")))).join(" | ")}"`);
    console.log(`  back at: ${new URL(page.url()).pathname}${new URL(page.url()).search ? " (with query)" : ""}`);
    await page.screenshot({ path: path.join(OUT, `${screen.name}-returned.png`) });
    const remove = page.getByRole("button", { name: "Remove GitHub App from this device", exact: true });
    if (!(await remove.count())) {
      // A reload of the guest vault lands where it lands; go back to GitHub.
      const skip = doorGuest(page);
      if (await skip.count()) await skip.click().catch(() => {});
      const unlock = page.getByRole("button", { name: /^Unlock/ }).first();
      if (await unlock.isVisible().catch(() => false)) await unlock.click();
      await page.waitForTimeout(2500);
      await openGithub(page);
    }
    await remove.first().waitFor({ timeout: 45_000 });
    await remove.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    console.log(`  keys before the press: ${(await keys(page)).join(" | ")}`);
    await page.screenshot({ path: path.join(into, `${screen.name}-saved-app.png`) });
    console.log(`  shot ${label}/${screen.name}-saved-app`);
    const touch = await page.evaluate(() => "ontouchstart" in window);
    if (touch) await remove.first().tap();
    else await remove.first().click();
    await page.waitForTimeout(1200);
    console.log(`  browser dialogs on the press: ${dialogs.length ? dialogs.join(" | ") : "none"}`);
    console.log(`  keys after one press: ${(await keys(page)).join(" | ")}`);
    console.log(`  focus after one press: ${await focusOf(page)}`);
    console.log(`  Saved app row still drawn: ${await page.getByText("OpenSesame evidence").count()}`);
    await page.screenshot({ path: path.join(into, `${screen.name}-remove-pressed.png`) });
    console.log(`  shot ${label}/${screen.name}-remove-pressed`);
    await context.close();
  }
} catch (error) {
  for (const entry of harness.log.filter((e) => !/external-request/.test(e.kind)).slice(-25))
    console.log(`  LOG ${entry.kind}: ${String(entry.detail).slice(0, 300)}`);
  throw error;
} finally {
  await browser.close();
}
const bad = harness.log.filter((entry) => /PAGE-ERROR|LOOPBACK|HTTP|FAIL/.test(entry.kind));
for (const entry of bad) console.log(`  ${entry.kind}: ${String(entry.detail).slice(0, 200)}`);
console.log(`captures: ${into}; walk log shots: ${OUT}`);

// Prove the vault's authentication flow works in a real browser, end to end,
// against the built Pages bundle served at the production origin with no
// backend (the same harness as verify-static-origin.mjs).
//
//   VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:auth
//
// Guest enrollment walks through a PIN first; password enrollment starts at MFA.
// The vault is its own authenticator (ADR 0113): the guest road opens with the
// code supplied in memory — never shown — while the password road trashes the
// registered entry first and walks the manual code road it leaves behind.
//
// Fails on any page error, console error, HTTP error (including 404),
// loopback request, or failed check. Screenshots and the
// on-screen text of every step land in artifacts/auth-flow/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  enterEnrollmentCode,
  finishUnlockSelfSupplied,
  finishUnlockWithCode,
  readSeed,
  withdrawSelfAuthenticator,
} from "./lib/auth-flow-enroll.mjs";
import { observeHttpFailures } from "./lib/http-failures.mjs";
import { totp } from "./lib/totp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "auth-flow"),
);
const PIN = "48291037";
const PASSWORD = "correct horse battery staple 2026";
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

const log = [];
let step = "boot";
const record = (kind, detail) => log.push({ step, kind, detail });
const failures = [];
function check(condition, what) {
  if (!condition) failures.push(`[${step}] ${what}`);
  record(condition ? "PASS" : "FAIL", what);
}

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

async function snap(page, name) {
  step = name;
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

/**
 * The seed, read the way a person without a camera reads it: the "Can't
 * scan?" alternative expands the setup key in place, inside the same sheet.
 */
async function openSecurity(page) {
  try {
    await page.getByRole("treeitem", { name: "Settings", exact: true }).click();
  } catch (error) {
    await snap(page, "settings-navigation-failed");
    fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
    throw error;
  }
  await page.waitForTimeout(600);
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("link", { name: /^security/i })
    .first()
    .click();
  await page.waitForTimeout(600);
}

async function lock(page) {
  // Two profile lock buttons exist (phone header, desktop rail); only one is
  // visible at any width.
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  await page.waitForTimeout(800);
}

process.on("unhandledRejection", () => undefined);
const launch = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM) {
  launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
}
const browser = await chromium.launch(launch);

// ---- 1: a guest asks for MFA and is walked through the key first
{
  const { page, context } = await newPage(browser);
  step = "1-guest";
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .click();
  await page.waitForTimeout(2000);
  check(/guest-\d+/.test(await text(page)), "guest landed inside the app");
  await openSecurity(page);
  const security = await snap(page, "1-guest-security");
  check(
    /Authenticator app/.test(security),
    "authenticator row present for a guest",
  );
  check(
    (await page.locator(".sw--method input").count()) === 0,
    "no row holds an input — the list is read-only state",
  );
  const totpRow = page.locator(".sw--method", { hasText: "Authenticator app" });
  const recoveryRow = page.locator(".sw--method", {
    hasText: "Recovery codes",
  });
  check(
    (await totpRow.getByRole("button", { name: "Add" }).count()) === 1,
    "Add is offered to a guest (not withheld)",
  );
  await totpRow.getByRole("button", { name: "Add" }).click();
  await page.waitForTimeout(500);
  const dialog = page.getByRole("dialog");
  const stepOne = await snap(page, "1-guest-step1-key");
  check(/1 · Key/.test(stepOne), "the rail starts at Key for a keyless vault");
  check(
    /3 · Confirm/.test(stepOne),
    "three steps announced before any is taken",
  );
  check(
    (await dialog
      .getByRole("img", { name: "Scan to add vault MFA" })
      .count()) === 0,
    "no QR code before a key exists",
  );
  // The passkey card is offered first (localhost can do WebAuthn); a PIN is
  // the alternative, expanded in the same sheet.
  await dialog.getByRole("button", { name: "Use a PIN instead" }).click();
  await page.waitForTimeout(300);
  await dialog.getByLabel("PIN", { exact: true }).fill(PIN);
  await dialog.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
  await dialog.getByRole("button", { name: "Set PIN" }).click();
  await page.waitForTimeout(3500);
  const stepTwo = await snap(page, "1-guest-step2-scan");
  check(/2 · Scan/.test(stepTwo), "scan follows the key on its own");
  check(
    (await dialog.locator(".steps__seg.is-now .steps__label").textContent()) ===
      "2 · Scan",
    "the rail marks Scan as the current step",
  );
  const secret = await readSeed(page, check);
  await dialog.getByRole("button", { name: "I scanned it" }).click();
  await page.waitForTimeout(300);
  await enterEnrollmentCode(page, "000000");
  await page.waitForTimeout(800);
  const refused = await snap(page, "1-guest-wrong-enroll-code");
  check(/did not match/i.test(refused), "a wrong enrollment code is refused");
  check(
    /3 · Confirm/.test(refused) && (await dialog.count()) === 1,
    "still in the sheet, on Confirm, after a wrong code",
  );
  await enterEnrollmentCode(page, totp(secret));
  await page.waitForTimeout(1500);
  const on = await snap(page, "1-guest-mfa-on");
  check(/Authenticator on/.test(on), "authenticator on after a matching code");
  check(
    /Recovery codes · shown once/.test(on) &&
      (await dialog.locator(".codes li").count()) === 10,
    "ten recovery codes are handed over once",
  );
  await dialog.getByRole("button", { name: "I saved them" }).click();
  await page.waitForTimeout(500);
  await snap(page, "1-guest-security-after");
  check((await page.getByRole("dialog").count()) === 0, "the sheet closed");
  check(
    (await totpRow.getByRole("button", { name: "Remove" }).count()) === 1 &&
      (await totpRow.getByRole("img", { name: "On" }).count()) === 1,
    "the row reports the authenticator on, with Remove as its one action",
  );
  check(
    (await recoveryRow.getByRole("img", { name: "Made" }).count()) === 1,
    "the Recovery row reports codes",
  );

  await lock(page);
  const locked = await snap(page, "1-guest-locked");
  check(/^Unlock$/m.test(locked), "lock lands on Unlock");
  check(
    (await page.getByRole("tab", { name: "PIN" }).count()) === 1,
    "the PIN tab is offered",
  );
  check(
    (await page.getByRole("tab", { name: "Password" }).count()) === 0 &&
      (await page.getByRole("tab", { name: "Passkey" }).count()) === 0,
    "no tab for a method that was never enrolled",
  );
  check(
    /1 · Key/.test(locked) && /2 · Authenticator code/.test(locked),
    "the code is announced as step 2 before the PIN is typed",
  );
  check(
    (await page.getByRole("button", { name: "Continue as guest" }).count()) ===
      1,
    "guest stays offered on the locked screen",
  );
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForTimeout(2500);
  await finishUnlockSelfSupplied(page, "1-guest", { check, snap });

  // Reload: the header on disk still carries the gate — the whole ceremony
  // again, from a fresh page load, without anything held in memory.
  step = "1-guest-reload";
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const reloaded = await snap(page, "1-guest-reloaded");
  check(/^Unlock$/m.test(reloaded), "a reload lands on Unlock");
  check(
    /2 · Authenticator code/.test(reloaded),
    "step 2 is announced after a reload",
  );
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForTimeout(2500);
  await finishUnlockSelfSupplied(page, "1-guest-reload", { check, snap });
  await context.close();
}

// ---- 2: a password-sealed vault enrolls MFA directly
{
  const { page, context } = await newPage(browser);
  step = "2-password";
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("tab", { name: "Password" }).click();
  await page.getByLabel("Master password", { exact: true }).fill(PASSWORD);
  await page
    .getByLabel("Confirm master password", { exact: true })
    .fill(PASSWORD);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Seal this device" }).click();
  await page.waitForTimeout(5000);
  check(/@/.test(await text(page)), "sealed device landed inside the app");
  await openSecurity(page);
  await page
    .locator(".sw--method", { hasText: "Authenticator app" })
    .getByRole("button", { name: "Add" })
    .click();
  await page.waitForTimeout(2500);
  const dialog = page.getByRole("dialog");
  const scan = await snap(page, "2-password-scan");
  check(
    (await dialog.locator(".steps__seg.is-now .steps__label").textContent()) ===
      "1 · Scan",
    "straight to Scan — no key step for a vault that has one",
  );
  check(
    /2 · Confirm/.test(scan) && !/Key/.test(scan),
    "two steps, no key step",
  );
  const secret = await readSeed(page, check);
  await dialog.getByRole("button", { name: "I scanned it" }).click();
  await page.waitForTimeout(300);
  await enterEnrollmentCode(page, totp(secret));
  await page.waitForTimeout(1500);
  check(/Authenticator on/.test(await text(page)), "authenticator on");
  await dialog.getByRole("button", { name: "I saved them" }).click();
  await page.waitForTimeout(500);
  // Withdraw the vault's own authenticator (ADR 0113): this road walks the
  // code by hand — the road a person gets once they trash the entry.
  await withdrawSelfAuthenticator(page, check);
  await lock(page);
  const locked = await snap(page, "2-password-locked");
  check(
    (await page.getByRole("tab", { name: "Password" }).count()) === 1 &&
      (await page.getByRole("tab", { name: "PIN" }).count()) === 0,
    "only the password tab is offered",
  );
  check(/2 · Authenticator code/.test(locked), "step 2 announced");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForTimeout(5000);
  await finishUnlockWithCode(page, secret, "2-password", {
    check,
    snap,
    totp,
  });
  await context.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));

const loopback = log.filter((entry) => entry.kind === "LOOPBACK-REQUEST");
const pageErrors = log.filter((entry) => entry.kind === "PAGE-ERROR");
const consoleErrors = log.filter((entry) => entry.kind === "console-error");
const httpErrors = log.filter((entry) => entry.kind === "HTTP-ERROR");
for (const entry of log)
  if (entry.kind === "PASS" || entry.kind === "FAIL")
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);
console.log(`loopback requests: ${loopback.length}`);
for (const [name, errors] of [
  ["HTTP", httpErrors],
  ["page", pageErrors],
  ["console", consoleErrors],
]) {
  console.log(
    `${name} errors: ${errors.length}`,
    errors.map((e) => `[${e.step}] ${e.detail.slice(0, 200)}`),
  );
}
const hard = [loopback, pageErrors, consoleErrors, httpErrors].flat().length;
if (failures.length || hard) {
  console.log(
    `\n${failures.length} failed checks, ${hard} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);

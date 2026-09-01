// Prove the vault's authentication flow works in a real browser, end to end,
// against the built Pages bundle served at the production origin with no
// backend (the same harness as verify-static-origin.mjs).
//
//   VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:auth
//
// Two people, two roads, one rule — an authenticator code guards a key:
//
//   1. GUEST → MFA. Continue as guest (no key on disk). Settings → Security →
//      Enroll MFA asks for the key first (step 1: a PIN, set right there),
//      then scans and confirms a code (step 2). Lock. The unlock screen
//      offers exactly the PIN tab and announces the code as step 2 before
//      the PIN is typed. PIN → code (computed here from the seed shown on
//      screen, as an authenticator app would) → the vault is open.
//   2. PASSWORD → MFA. Seal a fresh device with a master password, enroll
//      MFA directly (step 2 only), lock, unlock with password → code.
//   3. A wrong code after the right key is refused and stays on step 2.
//
// Fails on any page error, any console error other than the SPA-fallback
// 404, any loopback request, or any failed check. Screenshots and the
// on-screen text of every step land in artifacts/auth-flow/.
import crypto from "node:crypto";
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

/** RFC 6238 with the vault's parameters (SHA-1, 6 digits, 30 s), from the base32 seed. */
function totp(secret, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(ch);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = crypto
    .createHmac("sha1", Buffer.from(bytes))
    .update(counter)
    .digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

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
  page.on("console", (message) => {
    if (message.type() === "error")
      record("console-error", message.text().slice(0, 400));
  });
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

/** The otpauth URI the panel shows once, and the seed inside it. */
async function readSeed(page) {
  const uri = await page.locator(".set__unlock-secret").first().textContent();
  const secret = new URL(uri ?? "").searchParams.get("secret") ?? "";
  check(uri?.startsWith("otpauth://totp/"), "an otpauth URI is shown once");
  check(secret.length >= 16, "the URI carries a base32 seed");
  return secret;
}

async function openSecurity(page) {
  await page
    .getByRole("link", { name: /^settings/i })
    .first()
    .click();
  await page.waitForTimeout(600);
  await page
    .getByRole("link", { name: /^security/i })
    .first()
    .click();
  await page.waitForTimeout(600);
}

async function lock(page) {
  // Two lock buttons exist (phone top bar, desktop statusline); only one is
  // visible at any width.
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  await page.waitForTimeout(800);
}

/** After a right key: step 2 on screen, a wrong code refused, the right one opens. */
async function finishUnlockWithCode(page, secret, name) {
  const asked = await snap(page, `${name}-code-asked`);
  check(/Confirm it is you/.test(asked), "the code is asked for after the key");
  check(/Authenticator code/.test(asked), "code field on screen");
  check(
    (await page.locator(".steps__seg.is-now .steps__label").textContent()) ===
      "2 · Authenticator code",
    "the rail marks step 2 as the current step",
  );
  await page.getByLabel("Authenticator code", { exact: true }).fill("000000");
  await page.getByRole("button", { name: "Confirm MFA" }).click();
  await page.waitForTimeout(800);
  const refused = await snap(page, `${name}-wrong-code`);
  check(/not valid/i.test(refused), "a wrong code is refused in plain words");
  check(
    /Confirm it is you/.test(refused),
    "still on step 2 after a wrong code",
  );
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(totp(secret));
  await page.getByRole("button", { name: "Confirm MFA" }).click();
  await page.waitForTimeout(1500);
  const open = await snap(page, `${name}-open`);
  check(
    /vault\/|:\/\s*$/m.test(open) && !/Confirm it is you/.test(open),
    "the vault is open",
  );
  check(
    (await page.getByRole("button", { name: "Lock vault" }).count()) > 0,
    "the shell (with its lock) is on screen",
  );
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
  check(/guest\s*@/.test(await text(page)), "guest landed inside the app");
  await openSecurity(page);
  const security = await snap(page, "1-guest-security");
  check(/Authenticator MFA/.test(security), "MFA row present for a guest");
  check(
    (await page.getByRole("button", { name: "Enroll MFA" }).count()) === 1,
    "Enroll MFA is offered to a guest (not withheld)",
  );
  await page.getByRole("button", { name: "Enroll MFA" }).click();
  await page.waitForTimeout(500);
  const stepOne = await snap(page, "1-guest-step1-key");
  check(/1 · Set a key/.test(stepOne), "step 1 asks for a key");
  check(
    (await page.locator(".set__unlock-secret").count()) === 0,
    "no seed is shown before a key exists",
  );
  await page.getByLabel("PIN for this vault", { exact: true }).fill(PIN);
  await page
    .getByLabel("Confirm PIN for this vault", { exact: true })
    .fill(PIN);
  await page.getByRole("button", { name: "Use a PIN" }).click();
  await page.waitForTimeout(3500);
  const stepTwo = await snap(page, "1-guest-step2-scan");
  check(
    /2 · Scan and confirm/.test(stepTwo),
    "step 2 follows the key on its own",
  );
  const secret = await readSeed(page);
  await page.getByLabel("Authenticator code", { exact: true }).fill("000000");
  await page.getByRole("button", { name: "Turn on" }).click();
  await page.waitForTimeout(800);
  const refused = await snap(page, "1-guest-wrong-enroll-code");
  check(/did not match/i.test(refused), "a wrong enrollment code is refused");
  check(
    (await page.locator(".set__unlock-secret").count()) === 1,
    "the seed stays on screen after a wrong code",
  );
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(totp(secret));
  await page.getByRole("button", { name: "Turn on" }).click();
  await page.waitForTimeout(1200);
  const on = await snap(page, "1-guest-mfa-on");
  check(
    /Authenticator MFA is on/.test(on),
    "MFA turned on after a matching code",
  );
  check(
    /Required after every primary unlock/.test(on),
    "row reports MFA enrolled",
  );
  check(
    (await page.getByRole("button", { name: "Remove MFA" }).count()) === 1,
    "MFA can be removed",
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
  await finishUnlockWithCode(page, secret, "1-guest");

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
  await finishUnlockWithCode(page, secret, "1-guest-reload");
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
  await page.getByRole("button", { name: "Enroll MFA" }).click();
  await page.waitForTimeout(2500);
  const scan = await snap(page, "2-password-scan");
  check(
    (await page.locator(".steps__seg.is-now .steps__label").textContent()) ===
      "2 · Scan and confirm",
    "straight to scan and confirm — no key step for a vault that has one",
  );
  check(/2 · Scan and confirm/.test(scan), "step 2 on screen");
  const secret = await readSeed(page);
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(totp(secret));
  await page.getByRole("button", { name: "Turn on" }).click();
  await page.waitForTimeout(1200);
  check(/Authenticator MFA is on/.test(await text(page)), "MFA on");
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
  await finishUnlockWithCode(page, secret, "2-password");
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
const hard = loopback.length + pageErrors.length + consoleErrors.length;
if (failures.length || hard) {
  console.log(
    `\n${failures.length} failed checks, ${hard} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);

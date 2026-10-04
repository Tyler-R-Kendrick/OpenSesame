// Prove the device is the Identity plane on a static build with NO Identity API
// (ADR 0160), under the real production origin, at desktop and phone widths.
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   pnpm --filter @opensesame/pages verify:device-identity
//
// Same harness as `verify:static`: every request to the origin is served from
// `dist/`, every other origin is refused, and the run fails on any page error,
// console error, failed request, loopback request, or on-screen copy that
// names a service that is not there ("No Identity API", "localhost", "could
// not be", ...). Per width, a guest:
//
//   A. Settings › General draws no "sign out of Identity" row: the device has
//      no session yet, so there is nothing to sign out of (ADR 0158).
//   B. The connectivity status reads "This device", before and after Connect.
//   C. Connect from the Identity sheet ("Continue as guest") opens a device
//      session whose principal is `prn_` + a 43-character thumbprint, and
//      Refresh keeps the same principal: it is the vault's key, not a dice
//      roll.
//   D. Settings › General now draws the row.
//   E. Every Settings section reads clean (the forbidden-copy gate).
//   F. Access, once chosen: every tab reads clean, and Receipts is drawn only
//      once Browser-local IAM is on, because only it keeps an audit trail for
//      the device plane to serve.
//
// The Identity sheet is reached from the top bar, which a desktop does not
// draw; the desktop walk narrows the window to Connect and widens it again,
// with no reload, so the guest vault stays open.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  awaitCapabilitySections,
  capabilityOffSwitch,
  capabilityOnSwitch,
} from "./lib/always-on.mjs";
import { doorGuest } from "./lib/front-door.mjs";
import { waitOpen } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "device-identity"),
);

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const { log, failures, check, setStep, launch, newPage, snap } = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});

const SIGN_OUT = "Also sign out of Identity when the vault locks";
const PRINCIPAL = /\bprn_[A-Za-z0-9_-]{43}\b/;
const ACCESS_TABS = [
  "grants",
  "requests",
  "sessions",
  "connectors",
  "resources",
  "policies",
];

const WIDTHS = [
  {
    name: "desktop",
    size: { width: 1280, height: 900 },
    device: {},
    // The top bar, and with it the Identity sheet, is drawn below 901px.
    narrow: { width: 700, height: 900 },
  },
  {
    name: "phone",
    size: { width: 390, height: 844 },
    device: {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
    },
    narrow: null,
  },
];

/** In-app navigation: the router's own history, so no reload ends the vault. */
async function go(page, route) {
  await page.evaluate(
    ([base, to]) => {
      history.pushState({}, "", base + to.replace(/^\//, ""));
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [BASE, route],
  );
  await page.waitForTimeout(900);
}

async function signOutRowCount(page) {
  return page.getByRole("switch", { name: SIGN_OUT }).count();
}

async function openGeneral(page) {
  await go(page, "/settings");
  await page
    .getByRole("switch", { name: "Lock when this tab goes to the background" })
    .waitFor({ timeout: 15000 });
}

/** Open the More sheet and read what the Identity tile says. */
async function identityTile(page) {
  await page
    .getByRole("button", { name: /^More —/ })
    .first()
    .click();
  const tile = page.locator(".conn", { hasText: "Identity" }).first();
  await tile.waitFor({ timeout: 10000 });
  return tile;
}

async function connect(page, label) {
  const tile = await identityTile(page);
  const state = (await tile.locator(".conn__state").innerText()).trim();
  check(state === "This device", `${label}: the status reads "This device"`);
  await snap(page, `${label}-more-before`, { fullPage: false });
  await tile.click();
  const sheet = page.getByRole("dialog", { name: "Identity connection" });
  await sheet.waitFor({ timeout: 10000 });
  check(
    /No session/.test(await sheet.innerText()),
    `${label}: the sheet starts with no session`,
  );
  // Continuing as guest closes the sheet when the session is open.
  await sheet.getByRole("button", { name: "Continue as guest" }).click();
  await sheet.waitFor({ state: "detached", timeout: 15000 });
  await (await identityTile(page)).click();
  await sheet.getByText("Session active").waitFor({ timeout: 15000 });
  const first = PRINCIPAL.exec(await sheet.innerText())?.[0] ?? null;
  check(first !== null, `${label}: the principal is prn_ + a thumbprint`);
  await snap(page, `${label}-session`, { fullPage: false });
  await sheet.getByRole("button", { name: "Refresh session" }).click();
  await sheet.getByText("Session refreshed.").waitFor({ timeout: 15000 });
  const again = PRINCIPAL.exec(await sheet.innerText())?.[0] ?? null;
  check(
    first !== null && first === again,
    `${label}: Refresh keeps the same principal (it is the vault's key)`,
  );
  await sheet.getByRole("button", { name: "Close" }).first().click();
  await sheet.waitFor({ state: "detached", timeout: 10000 });
}

async function chooseCapability(page, title) {
  await go(page, "/settings/capabilities");
  await awaitCapabilitySections(page);
  const add = capabilityOffSwitch(page, title);
  await add.waitFor({ timeout: 15000 });
  await add.click();
  await page.getByTestId("capability-review").waitFor({
    state: "detached",
    timeout: 15000,
  });
  await capabilityOnSwitch(page, title).waitFor({ timeout: 15000 });
}

async function walkAccess(page, label, { receipts }) {
  for (const tab of ACCESS_TABS) {
    await go(page, `/access?view=${tab}`);
    const text = await snap(page, `${label}-access-${tab}`);
    check(
      !/Something went wrong|Uncaught/i.test(text),
      `${label}: Access ${tab} rendered`,
    );
    if (tab === "sessions") {
      const drawn = (await page.locator("#access-receipts").count()) > 0;
      check(
        drawn === receipts,
        `${label}: Receipts ${receipts ? "is" : "is not"} drawn on Sessions`,
      );
    }
  }
}

const browser = await launch();
for (const width of WIDTHS) {
  const label = width.name;
  const { page, context } = await newPage(browser, { device: width.device });
  await page.setViewportSize(width.size);
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  setStep(`${label}-guest`);
  await doorGuest(page).click();
  await waitOpen(page);

  // A + B
  await openGeneral(page);
  await snap(page, `${label}-general-before`);
  check(
    (await signOutRowCount(page)) === 0,
    `${label}: no sign-out row before the device has a session`,
  );

  // B + C
  setStep(`${label}-connect`);
  if (width.narrow) await page.setViewportSize(width.narrow);
  await connect(page, label);
  if (width.narrow) await page.setViewportSize(width.size);

  // D
  setStep(`${label}-general-after`);
  await openGeneral(page);
  await snap(page, `${label}-general-after`);
  check(
    (await signOutRowCount(page)) === 1,
    `${label}: the sign-out row is drawn once the device has a session`,
  );

  // E
  setStep(`${label}-settings`);
  const sections = await page
    .locator(".set__nav a")
    .evaluateAll((links) =>
      links.map((link) => link.getAttribute("href") ?? "").filter(Boolean),
    );
  check(sections.length > 1, `${label}: Settings lists its sections`);
  for (const href of sections) {
    const route = href.startsWith(BASE) ? href.slice(BASE.length - 1) : href;
    await go(page, route);
    const text = await snap(
      page,
      `${label}-settings-${route.replace(/[^a-z0-9]+/gi, "_")}`,
    );
    check(!/Something went wrong|Uncaught/i.test(text), `${label}: ${route}`);
  }

  // F
  setStep(`${label}-access`);
  await chooseCapability(page, "Access authority");
  await walkAccess(page, `${label}-no-iam`, { receipts: false });
  await chooseCapability(page, "Browser-local IAM");
  await walkAccess(page, `${label}-iam`, { receipts: true });

  await context.close();
}
await browser.close();

fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
for (const entry of log)
  if (entry.kind === "PASS" || entry.kind === "FAIL")
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);

const hard = log.filter((entry) =>
  [
    "LOOPBACK-REQUEST",
    "HTTP-ERROR",
    "PAGE-ERROR",
    "console-error",
    "ON-SCREEN",
    "MISSING-ASSET",
  ].includes(entry.kind),
);
for (const entry of hard) {
  console.log(`${entry.kind} [${entry.step}] ${entry.detail.slice(0, 240)}`);
}
if (failures.length || hard.length) {
  console.log(
    `\n${failures.length} failed checks, ${hard.length} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);

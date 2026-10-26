/**
 * Approved title-bar parity, measured against the built application.
 *
 *   PLAYWRIGHT_CHROMIUM=/usr/bin/chromium node apps/pages/scripts/verify-header-layout.mjs
 *
 * The viewport matrix includes both sides of the navigation breakpoint and
 * touch tablets, where a desktop-only floor would otherwise escape testing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import {
  checkHeaderGeometry,
  headerGeometry,
} from "./lib/header-layout-contract.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { privateTempDir } from "./lib/private-files.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out =
  process.env.PAGES_VERIFY_OUT ?? privateTempDir("opensesame-header-layout-");
const dist =
  process.env.PAGES_VERIFY_DIST ??
  fileURLToPath(new URL("../dist", import.meta.url));
fs.mkdirSync(out, { recursive: true });
const harness = createHarness({ dist, origin, base, out });
const browser = await harness.launch({ args: ["--no-sandbox"] });
const measurements = [];

const sizes = [
  { width: 320, height: 568, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 430, height: 932, touch: true },
  { width: 568, height: 320, touch: true },
  { width: 667, height: 375, touch: true },
  { width: 844, height: 390, touch: true },
  { width: 760, height: 700, touch: true },
  { width: 761, height: 700, touch: true },
  { width: 760, height: 700 },
  { width: 761, height: 700 },
  { width: 900, height: 700 },
  { width: 901, height: 700 },
  { width: 1024, height: 1366, touch: true },
  { width: 1366, height: 1024, touch: true },
  { width: 1672, height: 940 },
];

async function measure(page, label) {
  harness.setStep(label);
  const geometry = await page.evaluate(headerGeometry);
  measurements.push({ label, ...geometry });
  const check = (condition, message) =>
    harness.check(Boolean(condition), `${label}: ${message}`);
  checkHeaderGeometry(geometry, check);
}

/** Reach the requested control using native Tab traversal only. */
async function tabTo(page, target) {
  for (let step = 0; step < 80; step += 1) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error(
    `Header control is not reachable by Tab: ${await target.getAttribute("aria-label")}`,
  );
}

async function menus(page, label) {
  const header = page.locator(".app-header");
  const bell = header.getByRole("button", { name: /^Notifications —/ });
  // A real keyboard gesture opens each menu; Escape returns focus to the key.
  await tabTo(page, bell);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bell).toBeFocused();
  for (const [selector, menu] of [
    [".project-switcher .prompt__seg", ".project-switcher__menu"],
    [".account-switcher .prompt__seg", ".account-switcher__menu"],
  ]) {
    const key = header.locator(selector);
    await tabTo(page, key);
    await page.keyboard.press("Enter");
    const panel = header.locator(menu);
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    harness.check(
      box &&
        viewport &&
        box.x >= -1 &&
        box.y >= -1 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1,
      `${label}: ${menu} opens wholly inside the viewport`,
    );
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(key).toBeFocused();
  }
}

/**
 * Deliberately stress only text length, without inventing persisted identities.
 * Restore the live labels before screenshots; this is a layout constraint test,
 * not visual evidence of an actual account or a vault rename.
 */
async function stressLabels(page, label) {
  const saved = await page
    .locator(".app-header .prompt__name")
    .allTextContents();
  await page.locator(".app-header .prompt__name").evaluateAll((names) => {
    for (const name of names)
      name.textContent =
        "a-very-long-identity-name-that-cannot-fit-in-a-compact-title-bar";
  });
  try {
    await measure(page, `${label}-long-label-stress`);
    await menus(page, `${label}-long-label-stress`);
  } finally {
    await page
      .locator(".app-header .prompt__name")
      .evaluateAll((names, original) => {
        names.forEach((name, index) => {
          name.textContent = original[index];
        });
      }, saved);
  }
}

/** Exercise the actual browser offline event while install is also offered. */
async function offlineStatus(page, context) {
  await context.setOffline(true);
  const status = page.locator(".app-header .rail__presence [data-touch-twin]");
  try {
    await expect(status).toBeVisible();
    await expect(status).toHaveCSS("width", "44px");
    await expect(status).toHaveCSS("height", "44px");
    await measure(page, "320-offline-with-install");
  } finally {
    await context.setOffline(false);
    await expect(status).toBeHidden();
  }
}

try {
  for (const size of sizes) {
    const { page, context } = await harness.newPage(browser, {
      device: size.touch
        ? phoneContext(size)
        : { viewport: { width: size.width, height: size.height } },
    });
    await page.goto(`${origin}${base}`, { waitUntil: "domcontentloaded" });
    await doorGuest(page).click();
    await expect(
      page.getByRole("banner", { name: "Application", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".statusline .command-bar")).toBeVisible();
    // The host browser's eligibility event is controlled here so geometry is
    // exercised both before and after the optional install key appears. The
    // app's real listener and install store still handle that event.
    await measure(page, `${size.width}-install-unavailable`);
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      Object.defineProperty(event, "prompt", {
        value: async () => ({ outcome: "dismissed" }),
      });
      window.dispatchEvent(event);
    });
    await expect(
      page.locator('.app-header button[aria-label="Install OpenSesame"]'),
    ).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.waitForTimeout(150);
      const label = `${size.width}x${size.height}-${size.touch ? "touch" : "mouse"}-${theme}`;
      harness.setStep(label);
      await measure(page, label);
      if (theme === "dark") {
        await menus(page, label);
        await stressLabels(page, label);
        await page.screenshot({
          path: path.join(out, `${label}.png`),
          fullPage: false,
        });
      }
    }
    if (size.width === 320) await offlineStatus(page, context);
    // Resize a live shell across its navigation breakpoint. Fresh loads alone
    // miss duplicated controls and stale menus left behind by a layout swap.
    await page.setViewportSize({
      width: size.width <= 900 ? 1280 : 390,
      height: 844,
    });
    await page.waitForTimeout(150);
    await measure(page, `${size.width}-resized`);
    await context.close();
  }
} finally {
  await browser.close();
  fs.writeFileSync(
    path.join(out, "measurements.json"),
    JSON.stringify(measurements, null, 2),
  );
}
const faults = harness.log.filter((entry) =>
  ["PAGE-ERROR", "MISSING-ASSET"].includes(entry.kind),
);
for (const fault of faults)
  harness.check(false, `${fault.kind}: ${fault.detail}`);
fs.writeFileSync(
  path.join(out, "result.json"),
  JSON.stringify(
    { failures: harness.failures, measurements: measurements.length },
    null,
    2,
  ),
);
console.log(`Header evidence: ${out}`);
if (harness.failures.length) {
  console.error(harness.failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Header parity passed: ${measurements.length} layout measurements plus keyboard/menu checks.`,
  );

/**
 * The numbers the sheets in this folder quote, read out of the running build
 * rather than out of the source. Run it against each of the two builds:
 *
 *   node docs/evidence/2026-09-22-capability-composition/measure.mjs before
 *   node docs/evidence/2026-09-22-capability-composition/measure.mjs after
 *
 * It writes `measurements.<label>.json` beside itself. A caption that quotes
 * a number the reviewer cannot re-derive is an impression with a digit in it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { phoneContext } from "../../../apps/pages/scripts/lib/mobile-contract.mjs";
import { createHarness } from "../../../apps/pages/scripts/lib/static-origin-harness.mjs";

const label = process.argv[2];
if (!label) {
  console.error("usage: measure.mjs <before|after>");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = fileURLToPath(
  new URL("../../../apps/pages/dist", import.meta.url),
);
const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const harness = createHarness({
  dist,
  origin,
  base,
  out: path.join(here, `.measure-${label}.log`),
});

const press = async (page, name) => {
  const button = page.getByRole("button", { name: new RegExp(name, "i") });
  if ((await button.count()) === 0) return false;
  await button.first().click();
  await page.waitForTimeout(900);
  return true;
};

const browser = await harness.launch();
const out = {};
try {
  // ── the setup screen ──────────────────────────────────────────────────
  {
    const { page, context } = await harness.newPage(browser, {
      device: { viewport: { width: 1280, height: 900 } },
    });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(5200);
    await press(page, "Set up your own");
    out.setupTabs = await page
      .locator(".setup__tab")
      .allTextContents()
      .then((all) => all.map((text) => text.trim()));
    out.setupRoads = await page
      .locator(".capset__roads .road__name")
      .allTextContents();
    out.reachedCustomize = await press(page, "Customize this installation");
    out.purposeCards = await page.locator(".purpose .preset__name").count();
    if (out.reachedCustomize) await press(page, "Family");
    out.capabilityCards = await page.locator(".capcards > li").count();
    out.capabilityCardsSelected = await page
      .locator('.capcards [aria-pressed="true"], .capcards :checked')
      .count();
    await context.close();
  }

  // ── Settings ──────────────────────────────────────────────────────────
  for (const [key, device] of [
    ["desktop", { viewport: { width: 1280, height: 900 } }],
    ["phone", phoneContext({ width: 390, height: 844 })],
  ]) {
    const { page, context } = await harness.newPage(browser, { device });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(5200);
    await press(page, "Continue as guest");
    await page.waitForTimeout(1600);
    // The rail, not a reload: `goto` drops the guest session and lands back
    // on the unlock screen, which measures nothing.
    const sections = page.getByRole("button", { name: "Sections" }).first();
    if (await sections.count()) {
      await sections.click();
      await page.waitForTimeout(450);
      await page
        .locator(".drawer__row", { hasText: "Settings" })
        .first()
        .click();
    } else {
      await page
        .locator(".railtree__row", { hasText: "Settings" })
        .first()
        .click();
    }
    await page.waitForTimeout(1200);
    const nav = page.locator('nav[aria-label="Settings sections"] a');
    out[`settingsNav_${key}`] = (await nav.allTextContents()).map((text) =>
      text.trim(),
    );
    const link = page.getByRole("link", { name: "Capabilities", exact: true });
    out[`settingsHasCapabilities_${key}`] = (await link.count()) > 0;
    if (out[`settingsHasCapabilities_${key}`]) {
      await link.first().click();
      await page.waitForTimeout(1200);
      out[`capabilityRows_${key}`] = await page
        .locator(".capspanel__row")
        .count();
      out[`capabilityRowHeights_${key}`] = await page
        .locator(".capspanel__row")
        .first()
        .evaluate((node) => Math.round(node.getBoundingClientRect().height))
        .catch(() => null);
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const file = path.join(here, `measurements.${label}.json`);
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
console.log(`\nwrote ${path.relative(process.cwd(), file)}`);

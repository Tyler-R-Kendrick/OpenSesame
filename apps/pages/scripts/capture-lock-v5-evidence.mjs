/**
 * Capture lock-v5 unlock title evidence: settled gate + mid-doors ceremony.
 * Usage:
 *   node apps/pages/scripts/capture-lock-v5-evidence.mjs main|branch|reference <outDir>
 * main  → https://tyler-r-kendrick.github.io/OpenSesame/
 * branch → PAGES_DIST served at PAGES_ORIGIN (default https://tyler-r-kendrick.github.io)
 * reference → lock-v5-reference.html from dist (design parity still)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { passTheDoor } from "./lib/front-door.mjs";
import { PIN, lockVault, sealLocalOnly } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
const outDir = path.resolve(
  process.argv[3] ??
    path.join(
      here,
      "..",
      "..",
      "..",
      "docs/evidence/2026-10-10-lock-v5-title-screen",
    ),
);

if (mode !== "main" && mode !== "branch" && mode !== "reference") {
  console.error(
    "usage: capture-lock-v5-evidence.mjs main|branch|reference [outDir]",
  );
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

const DIST = process.env.PAGES_DIST ?? path.resolve(here, "..", "dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";

const VIEWPORTS = [
  [390, 844],
  [1024, 900],
  [1280, 900],
];

async function waitHeroSettled(page) {
  await page.waitForSelector(".unlock__hero .cipher-wordmark--settled", {
    timeout: 20_000,
  });
  await page.waitForTimeout(120);
}

async function walkToUnlock(page) {
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await passTheDoor(page);
  await sealLocalOnly(page);
  await lockVault(page);
  await page
    .locator(".unlock__title, h1.unlock__title")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await waitHeroSettled(page);
}

async function waitDoorsFrame(page) {
  await page.waitForSelector(".unlock.unlock--doors", { timeout: 6000 });
  await page.waitForFunction(
    () => {
      const unlock = document.querySelector(".unlock.unlock--doors");
      if (!unlock) return false;
      const shift = unlock.style.getPropertyValue("--unlock-door-shift");
      const progress = Number.parseFloat(shift);
      const seam = document.querySelector(".vault-doors__seam");
      return (Number.isFinite(progress) && progress > 12) || seam !== null;
    },
    { timeout: 4000 },
  );
  await page.waitForTimeout(80);
}

async function captureSet(browser, newPage, prefix) {
  for (const [width, height] of VIEWPORTS) {
    const { page, context } = await newPage(browser);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width, height });
    if (mode === "reference") {
      const refUrl = `${ORIGIN}${BASE}lock-v5-reference.html`;
      await page.goto(refUrl, { waitUntil: "networkidle" });
      await page
        .locator(".unlock__title")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
      await waitHeroSettled(page);
      const settled = path.join(
        outDir,
        `${prefix}-${width}-unlock-settled.png`,
      );
      await page.screenshot({ path: settled, fullPage: true });
      await context.close();
      continue;
    }

    await walkToUnlock(page);
    const settled = path.join(outDir, `${prefix}-${width}-unlock-settled.png`);
    await page.screenshot({ path: settled, fullPage: true });

    if (mode === "branch") {
      await page.getByLabel("PIN", { exact: true }).fill(PIN);
      const unlockBtn = page.getByRole("button", {
        name: "Unlock",
        exact: true,
      });
      await unlockBtn.click();
      try {
        await waitDoorsFrame(page);
        const shot = path.join(outDir, `${prefix}-${width}-unlock-doors.png`);
        await page.screenshot({ path: shot, fullPage: true });
      } catch (error) {
        console.warn(`no doors frame at ${width}px for ${prefix}: ${error}`);
      }
    }
    await context.close();
  }
}

let browser;
const closeHarness = async () => {};

if (mode === "main") {
  browser = await chromium.launch();
  const newPage = async (b) => {
    const context = await b.newContext();
    return { page: await context.newPage(), context };
  };
  await captureSet(browser, newPage, "before");
  await browser.close();
} else {
  const hasIndex = fs.existsSync(path.join(DIST, "index.html"));
  const hasReference = fs.existsSync(path.join(DIST, "lock-v5-reference.html"));
  if (mode === "reference") {
    if (!hasReference) {
      console.error(`missing lock-v5-reference.html in dist at ${DIST}`);
      process.exit(2);
    }
  } else if (!hasIndex) {
    console.error(`missing dist at ${DIST}`);
    process.exit(2);
  }
  const harness = createHarness({
    dist: DIST,
    origin: ORIGIN,
    base: BASE,
    out: path.join(outDir, "_harness"),
  });
  browser = await harness.launch();
  const prefix = mode === "reference" ? "reference" : "after";
  await captureSet(browser, harness.newPage.bind(harness), prefix);
  await browser.close();
}

console.log(`wrote captures under ${outDir}`);

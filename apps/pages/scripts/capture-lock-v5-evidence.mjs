/**
 * Capture lock-v5 unlock title evidence: settled gate + mid-doors ceremony.
 * Usage:
 *   node apps/pages/scripts/capture-lock-v5-evidence.mjs main|branch <outDir>
 * main  → https://tyler-r-kendrick.github.io/OpenSesame/
 * branch → PAGES_DIST served at PAGES_ORIGIN (default https://tyler-r-kendrick.github.io)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { passTheDoor } from "./lib/front-door.mjs";
import {
  PIN,
  lockVault,
  sealLocalOnly,
  unlockWithPin,
} from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
const outDir = path.resolve(
  process.argv[3] ??
    path.join(here, "..", "..", "..", "docs/evidence/2026-10-10-lock-v5-title-screen"),
);

if (mode !== "main" && mode !== "branch") {
  console.error("usage: capture-lock-v5-evidence.mjs main|branch [outDir]");
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

const DIST =
  process.env.PAGES_DIST ?? path.resolve(here, "..", "dist");
const ORIGIN =
  process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";

const VIEWPORTS = [
  [390, 844],
  [1024, 900],
  [1280, 900],
];

async function walkToUnlock(page) {
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await passTheDoor(page);
  await sealLocalOnly(page);
  await lockVault(page);
  await page
    .locator(".unlock__title, h1.unlock__title")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(600);
}

async function captureSet(browser, newPage, prefix) {
  for (const [width, height] of VIEWPORTS) {
    const { page, context } = await newPage(browser);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width, height });
    await walkToUnlock(page);
    const settled = path.join(outDir, `${prefix}-${width}-unlock-settled.png`);
    await page.screenshot({ path: settled, fullPage: true });

    if (mode === "branch") {
      await page.getByLabel("PIN", { exact: true }).fill(PIN);
      const unlockBtn = page.getByRole("button", { name: "Unlock", exact: true });
      await unlockBtn.click();
      const deadline = Date.now() + 4000;
      let shot = null;
      while (Date.now() < deadline) {
        const doors = await page.evaluate(() => {
          const unlock = document.querySelector(".unlock.unlock--doors");
          const fade = document.querySelector(".vault-doors--fade");
          const seam = document.querySelector(".vault-doors__seam");
          if (unlock || fade || seam) return true;
          return false;
        });
        if (doors) {
          shot = path.join(outDir, `${prefix}-${width}-unlock-doors.png`);
          await page.screenshot({ path: shot, fullPage: true });
          break;
        }
        await page.waitForTimeout(40);
      }
      if (!shot) {
        console.warn(`no doors frame at ${width}px for ${prefix}`);
      }
    }
    await context.close();
  }
}

let browser;
let closeHarness = async () => {};

if (mode === "main") {
  browser = await chromium.launch();
  const context = await browser.newContext();
  const newPage = async (b) => {
    const context = await b.newContext();
    return { page: await context.newPage(), context };
  };
  await captureSet(browser, newPage, "before");
  await browser.close();
} else {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
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
  await captureSet(browser, harness.newPage.bind(harness), "after");
  await browser.close();
}

console.log(`wrote captures under ${outDir}`);

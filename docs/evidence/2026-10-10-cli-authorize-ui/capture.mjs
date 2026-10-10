/**
 * Capture Authorize CLI sheet at 390px and 1280px from Storybook.
 * Run: pnpm --filter @opensesame/pages build-storybook
 *      pnpm --filter @opensesame/pages exec serve storybook-static -p 6006
 *      PLAYWRIGHT_CHROMIUM=… node docs/evidence/2026-10-10-cli-authorize-ui/capture.mjs
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;
const STORYBOOK = process.env.STORYBOOK_ORIGIN ?? "http://127.0.0.1:6006";
const STORY_ID = "modules-cliauthorizesheet--default";

async function capture(width) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width, height: Math.round(width * 1.6) },
  });
  page.on("pageerror", (err) => {
    throw err;
  });
  await page.goto(
    `${STORYBOOK}/iframe.html?id=${STORY_ID}&viewMode=story`,
    { waitUntil: "networkidle" },
  );
  await page.getByRole("dialog", { name: "Authorize CLI" }).waitFor({
    timeout: 30_000,
  });
  await page.screenshot({
    path: path.join(OUT, `authorize-cli-${width}.png`),
    fullPage: false,
  });
  await browser.close();
}

for (const width of [390, 1280]) {
  await capture(width);
}
console.log(`Wrote screenshots to ${OUT}`);

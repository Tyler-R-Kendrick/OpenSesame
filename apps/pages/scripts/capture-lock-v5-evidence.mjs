/**
 * Lock-v5 evidence: reference stage from `LockV5Demo` (branch
 * cursor/lock-v5-unlock-b359) and the production unlock gate at matched widths.
 *
 * `lock-v5.html` is not in git (searched main, cursor/lock-v5-unlock-b359,
 * claude/design-system-extraction-vvifv5, docs/). Dev reference:
 * http://localhost:5180/OpenSesame/dev/lock-v5 (Vite only).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { lockVault, sealWithPin } from "./lib/pages-journey.mjs";

const widths = [390, 1024, 1280];
const root = fileURLToPath(new URL("../../..", import.meta.url));
const outDir =
  process.argv[2] ??
  path.join(root, "docs/evidence/2026-10-10-lock-v5-title-screen");

const base = process.env.VITE_BASE ?? "/OpenSesame/";
const dist = path.join(root, "apps/pages/dist");
const origin = "https://tyler-r-kendrick.github.io";
async function capture(page, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
}

async function dialOverlapsNotes(page) {
  return page.evaluate(() => {
    const notes = document.querySelector(".unlock__notes");
    const overlay = document.querySelector(".cipher-dial__overlay");
    if (!notes || !(overlay instanceof HTMLCanvasElement)) return false;
    const nb = notes.getBoundingClientRect();
    const ctx = overlay.getContext("2d");
    if (!ctx || overlay.width < 2) return false;
    const { data, width, height } = ctx.getImageData(
      0,
      0,
      overlay.width,
      overlay.height,
    );
    const dpr = overlay.width / overlay.clientWidth;
    const x0 = Math.floor(nb.left * dpr);
    const x1 = Math.ceil(nb.right * dpr);
    const y0 = Math.floor(nb.top * dpr);
    const y1 = Math.ceil(nb.bottom * dpr);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] > 24) return true;
      }
    }
    return false;
  });
}

async function walkUnlock(browser, width) {
  const { page, context } = await harness.newPage(browser, {
    device: { viewport: { width, height: 900 } },
  });
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await lockVault(page);
  await page.waitForSelector(".unlock--lock-v5");
  await page.waitForTimeout(400);
  if (width < 1100) {
    const overlap = await dialOverlapsNotes(page);
    if (overlap) {
      throw new Error(`cipher dial overlay ink inside notes at width=${width}`);
    }
  }
  await capture(page, path.join(outDir, `unlock-${width}.png`));
  await context.close();
}

async function walkReferenceDev(browser, width) {
  const devOrigin = process.env.LOCK_V5_DEV_ORIGIN;
  if (!devOrigin) {
    console.warn(
      "skip reference capture: set LOCK_V5_DEV_ORIGIN (e.g. http://localhost:5180/OpenSesame) for LockV5Demo",
    );
    return;
  }
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`${devOrigin.replace(/\/$/, "")}/dev/lock-v5`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector(".lock-v5-demo__stage");
  await page.waitForTimeout(400);
  const stage = page.locator(".lock-v5-demo__stage");
  await capture(
    page,
    path.join(outDir, `reference-lock-v5-demo-${width}.png`),
  );
  await stage.screenshot({
    path: path.join(outDir, `reference-stage-${width}.png`),
  });
  await context.close();
}

const harness = createHarness({
  dist,
  origin,
  base,
  out: outDir,
});

async function main() {
  const browser = await harness.launch();
  try {
    for (const width of widths) {
      await walkUnlock(browser, width);
      await walkReferenceDev(browser, width);
    }
    console.log(`wrote lock-v5 evidence under ${outDir}`);
  } finally {
    await browser.close();
  }
}

await main();

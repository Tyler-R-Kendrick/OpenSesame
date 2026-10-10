/**
 * Lock-v5 evidence: LockV5Demo stage (reference) and production unlock gate.
 *
 * `lock-v5.html` is not in git. Reference geometry: `LockV5Demo` at
 * `/dev/lock-v5` (Vite dev only). Production unlock from `dist/`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { lockVault, sealWithPin, PIN } from "./lib/pages-journey.mjs";

const widths = [390, 1024, 1280];
const root = fileURLToPath(new URL("../../..", import.meta.url));
const outDir =
  process.argv[2] ??
  path.join(root, "docs/evidence/2026-10-10-lock-v5-title-screen");

const base = process.env.VITE_BASE ?? "/OpenSesame/";
const dist = path.join(root, "apps/pages/dist");
const origin = "https://tyler-r-kendrick.github.io";

const harness = createHarness({ dist, origin, base, out: outDir });

async function dialOverlapsNotes(page) {
  return page.evaluate(() => {
    const notes = document.querySelector(".unlock__notes");
    const overlay = document.querySelector(".cipher-dial__overlay");
    if (!notes || !(overlay instanceof HTMLCanvasElement)) return false;
    const nb = notes.getBoundingClientRect();
    const ctx = overlay.getContext("2d");
    if (!ctx || overlay.width < 2) return false;
    const { data, width } = ctx.getImageData(
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

async function openLockedUnlock(browser, width) {
  const { page, context } = await harness.newPage(browser, {
    device: { viewport: { width, height: 900 } },
  });
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await lockVault(page);
  await page.waitForSelector(".unlock--lock-v5");
  await page.waitForTimeout(350);
  return { page, context };
}

async function captureUnlockSettled(browser, width) {
  const { page, context } = await openLockedUnlock(browser, width);
  if (width < 1100) {
    const overlap = await dialOverlapsNotes(page);
    if (overlap) {
      throw new Error(`cipher dial overlay ink inside notes at width=${width}`);
    }
  }
  await page.screenshot({
    path: path.join(outDir, `unlock-${width}-settled.png`),
    fullPage: false,
  });
  await context.close();
}

async function captureUnlockDoors(browser, width) {
  const { page, context } = await openLockedUnlock(browser, width);
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".unlock.unlock--doors");
      if (!(el instanceof HTMLElement)) return false;
      const shift = el.style.getPropertyValue("--unlock-door-shift");
      const n = Number.parseFloat(shift);
      return Number.isFinite(n) && n > 28 && n < 78;
    },
    { timeout: 15_000 },
  );
  await page.waitForTimeout(80);
  await page.screenshot({
    path: path.join(outDir, `unlock-${width}-doors.png`),
    fullPage: false,
  });
  await context.close();
}

async function captureReferenceStage(browser, width) {
  const devOrigin = process.env.LOCK_V5_DEV_ORIGIN;
  if (!devOrigin) {
    console.warn(
      "skip reference-stage: set LOCK_V5_DEV_ORIGIN (http://localhost:5180/OpenSesame)",
    );
    return;
  }
  const devBase = new URL(devOrigin.replace(/\/$/, "") + "/");
  const { page, context } = await harness.newPage(browser, {
    device: { viewport: { width, height: 900 } },
    passthrough: [devBase.origin],
  });
  await page.goto(`${devBase.origin}${devBase.pathname}dev/lock-v5`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector(".lock-v5-demo__stage");
  await page.waitForTimeout(400);
  await page.locator(".lock-v5-demo__stage").screenshot({
    path: path.join(outDir, `reference-stage-${width}.png`),
  });
  await context.close();
}

let browser;

async function main() {
  browser = await harness.launch();
  try {
    for (const width of widths) {
      await captureReferenceStage(browser, width);
      await captureUnlockSettled(browser, width);
      await captureUnlockDoors(browser, width);
    }
    console.log(`wrote lock-v5 evidence under ${outDir}`);
  } finally {
    await browser.close();
  }
}

await main();

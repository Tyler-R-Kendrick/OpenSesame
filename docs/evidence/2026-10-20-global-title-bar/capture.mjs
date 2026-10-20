/** Real, unmodified local-vault builds at the same six viewport sizes. */
import fs from "node:fs";
import path from "node:path";
import { doorGuest } from "../../../apps/pages/scripts/lib/front-door.mjs";
import { phoneContext } from "../../../apps/pages/scripts/lib/mobile-contract.mjs";
import { createHarness } from "../../../apps/pages/scripts/lib/static-origin-harness.mjs";
const [stage, dist, rawOutput] = process.argv.slice(2);
if (!stage || !dist || !rawOutput)
  throw new Error(
    "usage: capture.mjs <before|after> <absolute dist> <raw output directory>",
  );
const out = path.join(rawOutput, stage);
fs.mkdirSync(out, { recursive: true });
const harness = createHarness({
  dist,
  origin: "https://tyler-r-kendrick.github.io",
  base: "/OpenSesame/",
  out,
});
const browser = await harness.launch({ args: ["--no-sandbox"] });
const sizes = [
  { width: 1672, height: 940 },
  { width: 320, height: 568, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 430, height: 932, touch: true },
  { width: 844, height: 390, touch: true },
  { width: 1024, height: 1366, touch: true },
];
const metrics = [];
try {
  for (const size of sizes) {
    const { page, context } = await harness.newPage(browser, {
      device: size.touch
        ? phoneContext(size)
        : { viewport: { width: size.width, height: size.height } },
    });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.goto("https://tyler-r-kendrick.github.io/OpenSesame/", {
      waitUntil: "networkidle",
    });
    await doorGuest(page).click();
    await page.locator(".command-bar").waitFor();
    await page.waitForTimeout(700);
    const label = `${size.width}x${size.height}`;
    metrics.push({
      label,
      ...(await page.evaluate(() => {
        const r = (s) => {
          const el = document.querySelector(s);
          if (!el?.getClientRects().length) return null;
          const b = el.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom };
        };
        return {
          header: r(".app-header"),
          oldToolbar: r(".mobile-toolbar"),
          main: r(".main"),
          rail: r(".rail"),
          footer: r(".statusline"),
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth,
          visibleBells: [
            ...document.querySelectorAll('[aria-label^="Notifications —"]'),
          ].filter((n) => n.getClientRects().length).length,
          visibleIdentity: [...document.querySelectorAll(".rail__prompt")]
            .filter((n) => n.getClientRects().length)
            .map((n) => n.textContent),
        };
      })),
    });
    await page.screenshot({
      path: path.join(out, `${label}.png`),
      fullPage: false,
    });
    console.log(stage, label, JSON.stringify(metrics.at(-1)));
    await context.close();
  }
} finally {
  await browser.close();
  fs.writeFileSync(
    path.join(out, "measurements.json"),
    JSON.stringify(metrics, null, 2),
  );
}

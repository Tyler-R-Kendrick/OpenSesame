/**
 * Visual evidence for a UI change: the same screens from the base build and
 * from the branch, laid side by side so a reviewer never has to run the app.
 *
 * Two steps, because the two builds cannot exist at once:
 *
 *   # 1. the base
 *   git checkout <base-sha> -- apps/pages/src
 *   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
 *   node apps/pages/scripts/capture-evidence.mjs capture before <journey.json>
 *
 *   # 2. the branch
 *   git checkout HEAD -- apps/pages/src
 *   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
 *   node apps/pages/scripts/capture-evidence.mjs capture after <journey.json>
 *
 *   # 3. the sheets
 *   node apps/pages/scripts/capture-evidence.mjs compose <journey.json>
 *
 * Only `apps/pages/src` is reverted for the base capture: the harness this
 * script drives lives under `apps/pages/scripts`, and reverting that would
 * take the capture with it.
 *
 * The journey file says which screens to visit and what each pair claims. It
 * is per-change and belongs beside the evidence it produced, because a caption
 * that outlives its change is a caption nobody rechecks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { composeSheet } from "./lib/visual-evidence.mjs";

const [mode, ...rest] = process.argv.slice(2);
const journeyPath = rest[rest.length - 1];
const label = mode === "capture" ? rest[0] : null;

if (!mode || !journeyPath || (mode === "capture" && !label)) {
  console.error(
    "usage: capture-evidence.mjs capture <before|after> <journey.json>",
  );
  console.error("       capture-evidence.mjs compose <journey.json>");
  process.exit(2);
}

const journey = JSON.parse(fs.readFileSync(journeyPath, "utf8"));
const root = path.resolve(path.dirname(journeyPath), journey.out ?? ".");
// Raw captures stay out of the repository: only the composed sheets are
// evidence, and two full phone walks of PNGs are not worth versioning.
const shots = path.join(
  os.tmpdir(),
  "opensesame-evidence",
  path.basename(journeyPath, ".json"),
);
const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const dist = fileURLToPath(new URL("../dist", import.meta.url));

const harness = createHarness({
  dist,
  origin,
  base,
  out: path.join(shots, ".log"),
});

/**
 * The steps a journey may take. Deliberately few and deliberately named after
 * what a person does, not what the DOM is: a journey file is read by whoever
 * is reviewing the evidence, and it has to say where the picture was taken.
 */
/** `tap()` needs a touch context; a desktop capture has a mouse instead. */
async function press(locator) {
  const touch = await locator.page().evaluate(() => "ontouchstart" in window);
  if (touch) await locator.tap();
  else await locator.click();
}

const STEPS = {
  async guest(page) {
    await press(
      page.getByRole("button", { name: "Continue as guest", exact: true }),
    );
    await page.waitForTimeout(1400);
  },
  async tab(page, name) {
    await press(page.locator(".tabbar__link", { hasText: name }).first());
    await page.waitForTimeout(900);
  },
  async press(page, name) {
    const target = page
      .getByRole("button", { name: new RegExp(name, "i") })
      .first();
    if (await target.count()) {
      await press(target);
      await page.waitForTimeout(1000);
    }
  },
  async open(page, name) {
    const link = page.getByRole("link", { name, exact: true }).first();
    if (await link.count()) {
      await press(link);
      await page.waitForTimeout(1100);
    }
  },
  async escape(page) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  },
};

async function capture(browser, into) {
  fs.mkdirSync(into, { recursive: true });
  for (const screen of journey.screens) {
    // A desktop pair has to be captured with a mouse: `phoneContext` forces
    // `hasTouch`, and a width-and-pointer rule would then show the phone
    // arrangement at 1280 — evidence of a screen nobody sees.
    const { page, context } = await harness.newPage(browser, {
      device: screen.desktop
        ? { viewport: { width: screen.width, height: screen.height } }
        : phoneContext({ width: screen.width, height: screen.height }),
    });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    // The wordmark reels settle in 2.31-4.62s (DESIGN.md). Both captures wait
    // them out, or the pair differs in ciphertext that means nothing.
    await page.waitForTimeout(5200);
    for (const step of screen.steps) {
      if (step.shot) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(into, `${step.shot}.png`) });
        console.log(`  ${path.basename(into)}/${step.shot}`);
        continue;
      }
      const [verb, argument] = Object.entries(step)[0];
      await STEPS[verb](page, argument);
    }
    await context.close();
  }
}

const browser = await harness.launch();
try {
  if (mode === "capture") {
    await capture(browser, path.join(shots, label));
  } else {
    fs.mkdirSync(root, { recursive: true });
    const dirs = {
      before: path.join(shots, "before"),
      after: path.join(shots, "after"),
    };
    for (const side of ["before", "after"]) {
      if (!fs.existsSync(dirs[side])) {
        console.error(
          `missing ${side} captures at ${dirs[side]} — run the capture step first`,
        );
        process.exit(1);
      }
    }
    for (const sheet of journey.sheets) {
      const file = await composeSheet(browser, sheet, dirs, root);
      console.log(`  ${path.relative(process.cwd(), file)}`);
    }
  }
} finally {
  await browser.close();
}

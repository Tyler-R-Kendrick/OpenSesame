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
import { capabilityOffSwitch } from "./lib/always-on.mjs";
import { menuSteps } from "./lib/capture-menu-steps.mjs";
import { placeSteps } from "./lib/capture-place-steps.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import { sealWithPassword } from "./lib/pages-journey.mjs";
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
// The production origin, unless a journey is evidence of what a dedicated
// deployment shows (a build stamped `dedicated_origin` for that origin).
const origin =
  process.env.EVIDENCE_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const dist = fileURLToPath(new URL("../dist", import.meta.url));

/**
 * `remote` maps an external URL to a repository-relative file served in its
 * place — only for a feature that reads a file this branch adds, which the
 * real host will not have until the branch lands. The README must say so.
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const remote = Object.fromEntries(
  Object.entries(journey.remote ?? {}).map(([url, file]) => [
    url,
    path.join(repoRoot, file),
  ]),
);

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
  /**
   * Seal a password vault on this device: the operator's own installation,
   * where Settings shows what a guest never sees (Allow guests, the
   * instance policy).
   */
  async seal(page) {
    await sealWithPassword(page);
    await page.waitForTimeout(1400);
  },
  async guest(page) {
    await press(
      page.getByRole("button", { name: "Continue as guest", exact: true }),
    );
    await page.waitForTimeout(1400);
  },
  async tab(page, name) {
    // A phone keeps its sections behind one key; a desktop has the rail.
    const key = page.getByRole("button", { name: "Sections" }).first();
    if (await key.count()) {
      await press(key);
      await page.waitForTimeout(450);
      await press(page.locator(".drawer__row", { hasText: name }).first());
    } else {
      await press(page.locator(".railtree__row", { hasText: name }).first());
    }
    await page.waitForTimeout(900);
  },
  async press(page, name) {
    const target = page
      .getByRole("button", { name: new RegExp(name, "i") })
      .first();
    if (await target.count()) {
      await press(target);
      await page.waitForTimeout(1000);
      return;
    }
    const tab = page.getByRole("tab", { name: new RegExp(name, "i") }).first();
    if (await tab.count()) {
      await press(tab);
      await page.waitForTimeout(1000);
      return;
    }
    throw new Error(
      `capture-evidence press("${name}"): no button or tab matched — refusing a silent miss`,
    );
  },
  /**
   * Optional means "skip when it is not there to press" — which includes a
   * control that is present but disabled. A base build that has not grown
   * the key yet, and a branch that correctly withholds it from a guest,
   * are both legitimate, and neither should hang the capture.
   */
  async pressOptional(page, name) {
    const target = page
      .getByRole("button", { name: new RegExp(name, "i") })
      .first();
    if ((await target.count()) && (await target.isEnabled())) {
      await press(target);
      await page.waitForTimeout(1000);
      return;
    }
    const tab = page.getByRole("tab", { name: new RegExp(name, "i") }).first();
    if (await tab.count()) {
      await press(tab);
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
  /**
   * Opens a rail branch so its panels are visible. The rail is a tree: a
   * branch row carries `aria-expanded`, and the caret is what opens it. A
   * branch this build does not have is a failure, not a quieter picture.
   */
  async expand(page, label) {
    const row = page
      .locator(".railtree__row[aria-expanded]")
      .filter({ hasText: label })
      .first();
    if ((await row.count()) === 0)
      throw new Error(
        `capture-evidence expand("${label}"): no rail branch matched — refusing a silent miss`,
      );
    if ((await row.getAttribute("aria-expanded")) !== "true") {
      await row.locator(".railtree__caret").click({ force: true });
      await page.waitForTimeout(800);
    }
  },
  ...menuSteps({ press }),
  ...placeSteps(),
  /**
   * Flip a named switch (`role="switch"`) when this build has it. A base
   * build that has no such switch is a legitimate difference, not a miss.
   */
  async switchOptional(page, name) {
    const target = page.getByRole("switch", { name, exact: true }).first();
    if ((await target.count()) && (await target.isEnabled())) {
      await press(target);
      await page.waitForTimeout(1000);
    }
  },
  /**
   * Tick a labelled checkbox when this build has it — an acknowledgement a
   * person gives before a commit key enables. Absent in a base build is a
   * legitimate difference, not a miss.
   */
  async checkOptional(page, name) {
    const box = page.getByRole("checkbox", { name, exact: true }).first();
    if ((await box.count()) && (await box.isEnabled())) {
      await press(box);
      await page.waitForTimeout(400);
    }
  },
  /**
   * Print how many elements match each selector, so a sheet's before/after
   * numbers are read from the browser rather than from the diff.
   */
  async count(page, selectors) {
    for (const selector of [selectors].flat()) {
      const n = await page.locator(selector).count();
      console.log(`  count ${selector}: ${n}`);
    }
  },
  /** `scrollTo`, for a heading only one of the two builds has. */
  async scrollToOptional(page, name) {
    const heading = page
      .getByRole("heading", { name: new RegExp(name, "i") })
      .first();
    if (!(await heading.count())) return;
    await heading.evaluate((node) => {
      node.scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.waitForTimeout(600);
  },
  /**
   * Switch an optional capability on, through Settings › Capabilities' own
   * switch and Apply (ADR 0130). An always-on one has no switch: skipped.
   */
  async enable(page, title) {
    await STEPS.tab(page, "settings");
    await STEPS.open(page, "Capabilities");
    const add = capabilityOffSwitch(page, title);
    if (!(await add.count())) return;
    await press(add.first());
    await page.waitForTimeout(400);
    await press(page.getByTestId("capability-apply"));
    await page
      .getByTestId("capability-review")
      .waitFor({ state: "detached", timeout: 20_000 });
    await page.waitForTimeout(600);
  },
  /** A new section loads with the app root, so a chosen one needs a reload. */
  async reload(page) {
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(5200);
    await STEPS.guest(page);
  },
  /** Follow a link to a path in the app, the way a shared deep link lands. */
  async visit(page, route) {
    await page.evaluate((href) => {
      history.pushState(null, "", href);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `${base}${route}`);
    await page.waitForTimeout(1200);
  },
  /** Print each match's box, so a sheet's numbers come from the browser. */
  async measure(page, selector) {
    const boxes = await page.locator(selector).evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return `${Math.round(box.width)}x${Math.round(box.height)} @${Math.round(box.left)},${Math.round(box.top)}`;
      }),
    );
    console.log(`  measure ${selector}: ${boxes.join(" | ") || "none"}`);
  },
  /**
   * Arrive at an address under the base, the way a person opens a link —
   * an invite's fragment included. A cold load: a fragment-only change is a
   * same-document navigation, which `visit` is for.
   */
  async arrive(page, address) {
    await page.goto("about:blank");
    await page.goto(`${origin}${base}${address}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(5200);
  },
  /** Print the address bar, so a sheet can show what a link left in it. */
  async address(page) {
    console.log(`  address: ${page.url()}`);
  },
  async escape(page) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  },
  /**
   * Type into a labelled field, the way a person pastes a definition. The
   * step carries either `text`, written as it is, or `json`, a value written
   * as the JSON it describes.
   */
  async fill(page, { label, text, json }) {
    const field = page.getByLabel(label, { exact: true }).first();
    if (!(await field.count()))
      throw new Error(
        `capture-evidence fill("${label}"): no field matched — refusing a silent miss`,
      );
    await field.fill(json === undefined ? text : JSON.stringify(json));
    await page.waitForTimeout(300);
  },
  /**
   * Print what the matched elements say, one line each. A sheet's
   * measurement is then read from the browser, not written from memory.
   */
  async report(page, selector) {
    const texts = await page.locator(selector).allInnerTexts();
    console.log(`  report ${selector}:`);
    for (const text of texts)
      console.log(`    ${text.replaceAll(/\s+/g, " ")}`);
  },
  /**
   * Bring a named heading to the top of the viewport. A panel below the
   * fold is still a screen someone looks at, and a full-page screenshot
   * would shrink the thing being evidenced until nobody could read it.
   */
  async scrollTo(page, name) {
    const heading = page
      .getByRole("heading", { name: new RegExp(name, "i") })
      .first();
    if (!(await heading.count()))
      throw new Error(
        `capture-evidence scrollTo("${name}"): no heading matched — refusing a silent miss`,
      );
    await heading.evaluate((node) => {
      node.scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.waitForTimeout(600);
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
      remote,
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

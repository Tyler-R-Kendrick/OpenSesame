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
  /** Right-click a rail row, the way a person asks a row what it can do. */
  async rightClick(page, text) {
    const row = page.locator(".railtree__row", { hasText: text }).first();
    if ((await row.count()) === 0)
      throw new Error(
        `capture-evidence rightClick("${text}"): no rail row matched — refusing a silent miss`,
      );
    await row.click({ button: "right" });
    await page.waitForTimeout(500);
  },
  /**
   * Hold a finger still on the first element matching `selector` — real CDP
   * touch events, the same the touch gate uses — then lift it.
   */
  async hold(page, selector) {
    const target = page.locator(selector).first();
    const box = await target.boundingBox();
    if (!box)
      throw new Error(
        `capture-evidence hold("${selector}"): nothing to hold — refusing a silent miss`,
      );
    const point = {
      x: Math.round(box.x + Math.min(box.width / 2, 48)),
      y: Math.round(box.y + box.height / 2),
    };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await page.waitForTimeout(900);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
    await page.waitForTimeout(700);
  },
  /** Pick a context-menu entry when this build has one (a base may not). */
  async menuOptional(page, name) {
    const entry = page
      .locator('[role="menu"] [role^="menuitem"]')
      .filter({ hasText: name })
      .first();
    if (await entry.count()) {
      await entry.click();
      await page.waitForTimeout(900);
    }
  },
  /**
   * Open the General settings file by whichever road this build has: the
   * base's YAML key on the section head, or the branch's command-bar path.
   */
  async openSettingsFile(page, category) {
    if (await page.locator(".set-raw").count()) return;
    const yaml = page.getByRole("button", { name: "YAML", exact: true });
    if (await yaml.count()) {
      await press(yaml);
    } else {
      await page
        .locator("#command-bar-input")
        .fill(`settings/${category}/config.yaml`);
      await page.keyboard.press("Enter");
    }
    await page.locator(".set-raw").waitFor({ timeout: 8000 });
    await page.waitForTimeout(700);
  },
  /** Log what the browser measures, so each caption quotes a number. */
  async measure(page, name) {
    const facts = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".railtree__row")];
      const items = [...document.querySelectorAll(".ctxmenu__item")];
      return {
        railRows: rows.length,
        trashRow: rows.some((row) =>
          row.getAttribute("href")?.endsWith("?f=trash"),
        ),
        configRows: rows.filter((row) =>
          row.textContent?.includes("config.yaml"),
        ).length,
        viewToggleKeys: document.querySelectorAll(
          ".section__head .set__view-btn",
        ).length,
        menuEntries: items.length,
        menuMode: document.querySelector(".ctxmenu--sheet")
          ? "sheet"
          : document.querySelector(".ctxmenu")
            ? "popover"
            : "none",
        menuCoversRow: (() => {
          const menu = document
            .querySelector(".ctxmenu")
            ?.getBoundingClientRect();
          const row = document
            .querySelector(".vtree__row")
            ?.getBoundingClientRect();
          if (!menu || !row) return null;
          return !(menu.bottom <= row.top || menu.top >= row.bottom);
        })(),
        url: location.pathname + location.search,
        menuEntryHeights: [
          ...new Set(
            items.map((item) =>
              Math.round(item.getBoundingClientRect().height),
            ),
          ),
        ],
        file: document.querySelector(".set-raw__path")?.textContent ?? null,
      };
    });
    console.log(`  measure ${name}: ${JSON.stringify(facts)}`);
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

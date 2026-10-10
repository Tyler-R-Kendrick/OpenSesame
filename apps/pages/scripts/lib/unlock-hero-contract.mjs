/**
 * Unlock hero CipherWordmark geometry + ink (lock-v5 desktop regressions):
 * the hero sits inside the left column with ≥24px margin to the notes
 * divider, and the canvas has non-zero letter-plate ink in both themes.
 */
import { lockVault, unlockWithPin } from "./pages-journey.mjs";

const COL_MARGIN = 24;
/** Settled plates cover a meaningful fraction of the canvas. */
const MIN_INK_RATIO = 0.02;

/** @param {import("@playwright/test").Page} page @param {"light"|"dark"} theme */
async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
}

/** @param {import("@playwright/test").Page} page @param {"light"|"dark"} theme */
async function heroInkReady(page, theme) {
  return page.evaluate(
    ({ want, minRatio }) => {
      if (document.documentElement.getAttribute("data-theme") !== want) {
        return false;
      }
      const canvas = document.querySelector(
        ".unlock__hero canvas.cipher-wordmark__canvas",
      );
      if (!(canvas instanceof HTMLCanvasElement) || canvas.width < 2) {
        return false;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let ink = 0;
      let light = 0;
      let dark = 0;
      let letterInk = 0;
      const markEnd = Math.floor(canvas.width * 0.18);
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (data[i + 3] < 8) continue;
          ink++;
          if (x > markEnd) letterInk++;
          const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
          if (lum > 160) light++;
          else if (lum < 100) dark++;
        }
      }
      const total = canvas.width * canvas.height;
      if (ink / total < minRatio || letterInk / total < minRatio * 0.5) {
        return false;
      }
      return want === "dark" ? light > dark : dark > light;
    },
    { want: theme, minRatio: MIN_INK_RATIO },
  );
}

/** @param {import("@playwright/test").Page} page @param {"light"|"dark"} theme */
async function waitHeroInk(page, theme) {
  await setTheme(page, theme);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await heroInkReady(page, theme)) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`unlock hero ink not ready for theme=${theme}`);
}

/** @param {import("@playwright/test").Page} page */
async function readHeroGeometry(page) {
  return page.evaluate(() => {
    const hero = document.querySelector(".unlock__hero");
    const canvas = hero?.querySelector("canvas");
    const notes = document.querySelector(".unlock__notes");
    const pane = document.querySelector(".unlock");
    if (!hero || !(canvas instanceof HTMLCanvasElement) || !pane) return null;
    const hb = hero.getBoundingClientRect();
    const cb = canvas.getBoundingClientRect();
    const nb = notes?.getBoundingClientRect();
    const pr = pane.getBoundingClientRect();
    const ctx = canvas.getContext("2d");
    let ink = 0;
    let letterInk = 0;
    if (ctx) {
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const markEnd = Math.floor(canvas.width * 0.18);
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (data[i + 3] < 8) continue;
          ink++;
          if (x > markEnd) letterInk++;
        }
      }
    }
    return {
      heroLeft: hb.left - pr.left,
      canvasRight: cb.right - pr.left,
      notesLeft: nb ? nb.left - pr.left : null,
      ink,
      letterInk,
      canvasPx: canvas.width * canvas.height,
    };
  });
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {(ok: boolean, msg: string) => void} check
 * @param {"light"|"dark"} theme
 * @param {boolean} wide
 */
async function checkHeroTheme(page, check, theme, wide) {
  await waitHeroInk(page, theme);
  const geom = await readHeroGeometry(page);
  check(geom !== null, `unlock hero is mounted (${theme})`);
  if (!geom) return;

  check(
    geom.ink > 0 &&
      geom.ink / Math.max(1, geom.canvasPx) >= MIN_INK_RATIO &&
      geom.letterInk / Math.max(1, geom.canvasPx) >= MIN_INK_RATIO * 0.5,
    `unlock hero has non-zero plate ink in ${theme} (ink=${geom.ink}, letters=${geom.letterInk}/${geom.canvasPx})`,
  );

  if (!wide || geom.notesLeft === null) return;
  const margin = geom.notesLeft - geom.canvasRight;
  check(
    margin >= COL_MARGIN - 0.5,
    `unlock hero stays ≥${COL_MARGIN}px inside the left column in ${theme} (margin=${margin.toFixed(1)}px; heroRight=${geom.canvasRight.toFixed(1)}, notes=${geom.notesLeft.toFixed(1)})`,
  );
  check(
    geom.heroLeft >= -0.5,
    `unlock hero left edge stays in the pane in ${theme} (left=${geom.heroLeft.toFixed(1)})`,
  );
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {(ok: boolean, msg: string) => void} check
 */
export async function checkUnlockHero(page, check) {
  await page.waitForSelector(".unlock__hero .cipher-wordmark", {
    timeout: 15_000,
  });
  await page
    .locator(".unlock__hero .cipher-wordmark--settled")
    .waitFor({ state: "attached", timeout: 12_000 })
    .catch(() => {});
  await page.waitForTimeout(80);

  const wide = (page.viewportSize()?.width ?? 0) >= 1100;
  for (const theme of ["light", "dark"]) {
    await checkHeroTheme(page, check, theme, wide);
  }
}

/**
 * Lock → assert hero → unlock. Keeps the step out of verify-static's line budget.
 * @param {import("@playwright/test").Page} page
 * @param {(ok: boolean, msg: string) => void} check
 */
export async function walkUnlockHero(page, check) {
  await lockVault(page);
  await checkUnlockHero(page, check);
  await unlockWithPin(page);
}

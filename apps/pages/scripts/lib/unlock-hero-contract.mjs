/**
 * Unlock hero CipherWordmark geometry + ink (lock-v5 desktop regressions):
 * the hero sits inside the left column with ≥24px margin to the notes
 * divider, and the canvas has non-zero ink in both themes.
 */
const COL_MARGIN = 24;
/** Settled plates cover a meaningful fraction of the canvas. */
const MIN_INK_RATIO = 0.02;

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
    .catch(() => {
      /* static / reduced-motion may already be settled without the class race */
    });
  await page.waitForTimeout(80);

  const viewport = page.viewportSize();
  const wide = (viewport?.width ?? 0) >= 1100;

  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-theme", t);
    }, theme);
    // Theme MutationObserver repaints ink; wait for non-zero coverage.
    await page.waitForFunction(
      ({ theme: want, minRatio }) => {
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
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 8) continue;
          ink += 1;
          const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
          if (lum > 160) light += 1;
          else if (lum < 100) dark += 1;
        }
        const total = canvas.width * canvas.height;
        if (ink / total < minRatio) return false;
        // Dark theme → light plates; light theme → dark plates.
        return want === "dark" ? light > dark : dark > light;
      },
      { theme, minRatio: MIN_INK_RATIO },
      { timeout: 5_000 },
    );

    const geom = await page.evaluate(() => {
      const hero = document.querySelector(".unlock__hero");
      const canvas = hero?.querySelector("canvas");
      const notes = document.querySelector(".unlock__notes");
      const pane = document.querySelector(".unlock");
      if (!hero || !canvas || !pane) return null;
      const hb = hero.getBoundingClientRect();
      const cb = canvas.getBoundingClientRect();
      const nb = notes?.getBoundingClientRect();
      const pr = pane.getBoundingClientRect();
      const ctx = canvas.getContext("2d");
      let ink = 0;
      if (ctx && canvas instanceof HTMLCanvasElement) {
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] >= 8) ink += 1;
        }
      }
      return {
        heroLeft: hb.left - pr.left,
        heroRight: hb.right - pr.left,
        canvasRight: cb.right - pr.left,
        notesLeft: nb ? nb.left - pr.left : null,
        ink,
        canvasPx:
          canvas instanceof HTMLCanvasElement
            ? canvas.width * canvas.height
            : 0,
      };
    });

    check(geom !== null, `unlock hero is mounted (${theme})`);
    if (!geom) continue;

    check(
      geom.ink > 0 && geom.ink / Math.max(1, geom.canvasPx) >= MIN_INK_RATIO,
      `unlock hero has non-zero ink coverage in ${theme} (ink=${geom.ink}/${geom.canvasPx})`,
    );

    if (wide && geom.notesLeft !== null) {
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
  }
}

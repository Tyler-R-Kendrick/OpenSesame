/**
 * Capture verbs for the tutorial mode (ADR 0160): open Support, start a
 * tutorial, and press Next — in the base build as well, where a tutorial is
 * started from a written-help answer and carries no Next of its own, so one
 * journey walks both builds and the pair differs only by the change.
 */

function supportKey(page) {
  return page
    .getByRole("button", { name: /^Support/ })
    .locator("visible=true")
    .first();
}

async function press(locator) {
  const touch = await locator.page().evaluate(() => "ontouchstart" in window);
  if (touch) await locator.tap();
  else await locator.click();
}

export function tourSteps() {
  return {
    /** Open the Support sheet, unless it is already open. */
    async supportOpen(page) {
      const sheet = page.getByRole("dialog", { name: "Support", exact: true });
      if (await sheet.isVisible().catch(() => false)) return;
      await press(supportKey(page));
      await page.waitForTimeout(900);
    },
    /** Show the Tutorials tab where this build has one. */
    async tutorialsTab(page) {
      const tab = page.getByRole("tab", { name: "Tutorials", exact: true });
      if (await tab.count()) {
        await press(tab);
        await page.waitForTimeout(700);
      }
    },
    /**
     * Start a tutorial. This build's library row by its title, or — where the
     * build has no library — the "Show me" beside the written answer.
     */
    async tour(page, { title, question }) {
      const row = page
        .locator("[data-tutorial]")
        .filter({ hasText: title })
        .first();
      if (await row.count()) {
        await press(row);
      } else {
        const article = page
          .getByRole("article")
          .filter({ hasText: question })
          .first();
        await press(article.getByRole("button", { name: "Show me" }).first());
      }
      await page.waitForTimeout(1600);
    },
    /** Next, where the tutorial has one; the base's popover may not. */
    async tourNext(page) {
      const next = page
        .getByRole("button", { name: /^Next/ })
        .locator("visible=true")
        .first();
      if (await next.count()) {
        await press(next);
      } else {
        const driven = page.locator(".driver-popover-next-btn").first();
        if (await driven.count()) await press(driven);
      }
      await page.waitForTimeout(1100);
    },
    /** Print the tutorial card's box and the lit control's, for a sheet's numbers. */
    async tourMeasure(page) {
      const read = async (selector) =>
        page
          .locator(selector)
          .first()
          .evaluate((node) => {
            const box = node.getBoundingClientRect();
            return `${Math.round(box.width)}x${Math.round(box.height)} @${Math.round(box.left)},${Math.round(box.top)}`;
          })
          .catch(() => "none");
      const card = await read(".coach__card, .driver-popover");
      const panel = await read(".support__sheet, .support");
      console.log(`  tour card ${card} | support panel ${panel}`);
    },
  };
}
